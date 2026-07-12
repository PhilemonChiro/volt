# Volt Library Registry — System Architecture

A secure, curated distribution system for Volt device libraries: authors create and
submit libraries on the web, a review pipeline vets them, the registry **signs** the
approved artifact, and the **Volt IDE** verifies and imports only signed, sandboxed
packages. The IDE never creates libraries and never trusts unsigned foreign code.

---

## 1. Goals & non-goals

| Goal | How |
|---|---|
| No unsigned foreign code ever compiled/flashed | Signed `.vlib` only; hardened import |
| A review miss is *contained*, not catastrophic | Sandboxed import (paths/allowlist/caps) + curation |
| Poisoned **updates** can't sneak in | Per-version review, version+hash pinning, no auto-update |
| Grow the ecosystem | Browse/install/publish are **free**; monetize AI/Pro only |
| Match how we already build | Mirror the `lovelane` Go + Next.js + Dokploy stack |

**Non-goals:** library creation in the IDE (web-only); DRM/encryption of source
(we sign for *authenticity*, not confidentiality); charging for the ecosystem.

---

## 2. Security model in one line

> **Curation** (you review) **+ Signing** (provenance) **+ Hardened import** (containment).
> Signing proves *who*; review proves *vetted*; the sandbox ensures a review miss can't
> escape `devices/`. Same trust model as an app store.

Encryption is *not* the security primitive here — a signed-but-malicious lib is still
malicious, and an encrypted one is no safer. **Sign, don't (just) encrypt.**

---

## 3. System context

```mermaid
flowchart TB
    Author(["Author"]) --> Web
    Reviewer(["You / Reviewer"]) --> Admin
    Maker(["Maker / IDE user"]) --> Browse

    subgraph IDE["Volt IDE (Electron) — CONSUMER ONLY"]
        Browse["Library Browser"]
        Verify["vlib-verify<br/>Ed25519 + pinned key-set"]
        Import["Hardened Importer"]
        Devices[("devices/ installed libs")]
        Build["Compiler + Build + Flash"]
        Browse --> Verify --> Import --> Devices --> Build
    end

    subgraph Registry["Volt Registry (Dokploy)"]
        Web["registry-web (Next.js)<br/>Creator + Marketplace + hosted test"]
        Admin["registry-admin<br/>Review console"]
        API["registry-api (Go, chi + pgx)"]
        Sign["pkg/sign — Ed25519 signer"]
        DB[("Postgres 16 + PgBouncer")]
        Blob[("MinIO — .vlib blobs")]
        Redis[("Redis + asynq")]
        Web --> API
        Admin --> API
        API --> DB
        API --> Blob
        API --> Redis
        API --> Sign
    end

    Browse -->|"browse / search"| API
    API -->|"signed .vlib"| Verify
    Sign -.->|"publishes signed key-set + revocation list"| Verify
```

---

## 4. The `.vlib` package format

A **single signed JSON envelope** — *not* an archive (no zip-slip, symlink, or
path-traversal surface at extraction time; you parse fields, you never "extract").

```jsonc
{
  "schema": 1,
  "manifest": {
    "name": "BMP280", "prefix": "bmp280", "version": "1.2.0",
    "interface": "i2c", "capabilities": ["i2c"],
    "author": "gh:alice", "publishedAt": "2026-07-11T…Z",
    "minVoltVersion": "2.1.0", "trustTier": "verified"
  },
  "device": { /* device.json — strict-schema validated */ },
  "driver": { "common": "<C source>", "esp32": "<C?>", "rp2040": "<C?>" },
  "header": { "fields": [ … ], "methods": [ … ] },   // STRUCTURED, not raw C
  "hash":      "sha256:…",     // over canonical(manifest+device+driver+header)
  "signature": "ed25519:…"     // over hash, by the registry key
}
```

```mermaid
flowchart LR
    subgraph Envelope[".vlib envelope"]
        M["manifest<br/>(name, ver, caps, tier)"]
        D["device.json<br/>(schema-validated data)"]
        DR["driver.{common,esp32,rp2040}<br/>(the ONLY raw C)"]
        H["header spec<br/>(structured fields/methods)"]
    end
    Envelope --> CJ["Canonicalize (RFC 8785 JCS)"] --> HS["SHA-256 → hash"] --> SG["Ed25519 signature"]
```

**Key decision:** the only raw code is `driver.c` (unavoidable — it compiles for the
MCU, contained). Everything else is *data*: `device.json` is schema-validated, and the
`<prefix>_t` struct + prototypes are a **structured spec the IDE re-emits itself** — so
raw code can never be injected into a shared header or the build system.

---

## 5. Cryptography — signing & verification

- **Algorithm:** Ed25519 (fast, tiny signatures; Node's built-in `crypto` and Go's
  `crypto/ed25519` — zero extra deps in the IDE).
- **Canonicalization:** RFC 8785 **JCS** on both sides, so the bytes hashed in Go equal
  the bytes hashed in Node. *This is the highest-risk interop detail in the system.*
- **Pinned key-set (rotatable):** the IDE ships a **signed key-set**, not one hardcoded
  key. An old key signs the new key-set → rotate/add keys without shipping a new IDE.
- **Verification is offline** (works air-gapped); an **optional online revocation check**
  (signed, cached) kills a compromised version.

```mermaid
flowchart LR
    subgraph Server["registry-api (Go) — SIGN"]
        A["Reviewed artifact"] --> J1["JCS canonical"] --> S1["SHA-256"] --> SG["Ed25519 sign<br/>(private key, Dokploy secret)"]
        SG --> V["Signed .vlib"]
    end
    subgraph Client["Volt IDE (Node) — VERIFY"]
        V --> J2["JCS canonical"] --> S2["SHA-256"] --> VF["Ed25519 verify"]
        VF --> OK{"match AND<br/>not revoked?"}
        OK -- yes --> PASS["proceed to hardened import"]
        OK -- no --> REJ["reject"]
    end
    KS["Signed key-set"] -.-> VF
    RL["Signed revocation list"] -.-> OK
```

---

## 6. Author flow — create → submit → review → sign → publish

```mermaid
sequenceDiagram
    actor Author
    participant Web as registry-web
    participant API as registry-api
    participant Q as asynq pre-screen
    participant Admin as Reviewer (admin)
    participant Sign as pkg/sign (Ed25519)
    participant DB as Postgres

    Author->>Web: Wizard: metadata + methods + driver.c
    Web->>Web: hosted compile + Wokwi test (author dev loop)
    Author->>Web: Submit version
    Web->>API: POST /libraries/:id/versions (draft)
    API->>Q: enqueue pre-screen
    Q->>Q: schema + path/allowlist + capability scan + str.format check
    Q-->>API: pass / fail (+ findings)
    API->>DB: status = pending-review
    Admin->>API: GET review queue
    Admin->>API: approve(version) or reject(findings)
    API->>Sign: sign(JCS-hash(artifact))
    Sign-->>API: ed25519 signature
    API->>DB: status = published (semver, hash, sig)
    API-->>Web: published ✔
```

Automated pre-screen (a hard gate before human eyes):

```mermaid
flowchart TD
    S["Submission"] --> P1{"Strict schema<br/>(manifest + device.json)"}
    P1 -- fail --> X["Auto-reject with findings"]
    P1 -- ok --> P2{"Filenames on allowlist<br/>device.json + driver.c only"}
    P2 -- fail --> X
    P2 -- ok --> P3{"driver.c uses only allowlisted volt_* APIs"}
    P3 -- fail --> X
    P3 -- ok --> P4{"Declared capabilities match usage"}
    P4 -- fail --> X
    P4 -- ok --> P5{"init_args template allowlisted"}
    P5 -- fail --> X
    P5 -- ok --> HQ["Human review queue"]
```

---

## 7. Consumer flow — browse → install → verify → import

```mermaid
sequenceDiagram
    actor User as Maker
    participant IDE as Volt IDE
    participant API as registry-api
    participant Vf as vlib-verify
    participant Im as Hardened Importer
    participant FS as devices/

    User->>IDE: Browse / search
    IDE->>API: GET /libraries?q=bmp
    API-->>IDE: catalog (name, ver, caps, tier, author)
    User->>IDE: Install BMP280@1.2.0
    IDE->>API: GET /libraries/bmp280/1.2.0/download
    API-->>IDE: signed .vlib envelope
    IDE->>Vf: verify(envelope)
    Vf->>Vf: JCS → SHA-256 → Ed25519 vs pinned key-set
    Vf->>API: (optional) revocation check
    Vf-->>Im: verified
    Im->>Im: schema + name regex + header regen + template + capability scan
    Im->>User: Consent (source + caps + tier + author)
    User-->>Im: Install
    Im->>FS: write devices/bmp280/{device.json, driver.c}
    Im->>IDE: pin version + hash in installed-libs.json
```

---

## 8. The hardened importer (IDE secure core)

```mermaid
flowchart TD
    A["Signed .vlib"] --> B{"Signature valid?"}
    B -- no --> R1["Reject — bad signature"]
    B -- yes --> C{"Revoked?"}
    C -- yes --> R2["Reject — revoked"]
    C -- no --> D{"Schema valid?"}
    D -- no --> R3["Reject — schema"]
    D -- yes --> E{"name = a-z0-9_ , 1-32 chars?"}
    E -- no --> R4["Reject — bad name"]
    E -- yes --> F{"init_args placeholders allowlisted?"}
    F -- no --> R5["Reject — template injection"]
    F -- yes --> G{"driver.c: only volt_* APIs?<br/>capabilities match declared?"}
    G -- no --> R6["Reject / flag — capability"]
    G -- yes --> H["Regenerate header from structured fields<br/>(types allowlisted — NEVER paste raw C)"]
    H --> I["Consent UI — source + caps + tier + author"]
    I -- cancel --> R7["Abort"]
    I -- install --> J["Write ONLY devices/&lt;name&gt;/ — device.json + driver.c"]
    J --> K["Pin version + hash in installed-libs.json"]
    K --> DONE["Installed"]
```

Defenses embodied here: **path allowlist** (no traversal, no writing outside
`devices/<name>/`), **no build hooks** (only `.json` + `.c` accepted → no host RCE),
**structured header regen**, **template allowlist** (kills the `str.format` hole),
**capability + static scan**, and **explicit consent**.

---

## 9. Trust tiers & capabilities

```mermaid
flowchart LR
    Mine["My libs<br/>(yours — trusted)"] --> Verified["Verified<br/>(reviewed + signed by you)"]
    Verified --> Community["Community<br/>(author-signed, UNREVIEWED)"]
    Community -->|"install"| Warn["Explicit 'unverified' warning<br/>+ source consent"]
```

**Capabilities** (declared in the manifest, enforced by the static scan, shown on
consent): `i2c`, `spi`, `gpio`, `uart`, `network`, `storage`.
A distance sensor declaring `network` is an instant review flag.

---

## 10. Threat model

| Threat | Defense |
|---|---|
| Tampered / forged `.vlib` | Ed25519 signature + pinned, rotatable key-set |
| Zip-slip / path traversal | JSON envelope + `devices/<name>/` write allowlist |
| Build-time RCE on user's laptop | No build hooks; only `.json` + `.c` accepted |
| Codegen format-string exploit | `str.format` → explicit substitution + template allowlist |
| Malicious header/macro injection | Header regenerated from structured spec (never raw C) |
| Malicious C on the MCU | Capability declaration + static scan + **your review** + consent |
| **Poisoned update** (the real one) | Per-version review, version+hash pinning, no silent update |
| Typosquatting in "universe" libs | Curation gate + trust tiers + author identity |
| Compromised signing key | Key-set rotation + signed revocation list |
| Malicious registry response (MITM) | Client verifies signature offline regardless of transport |

Residual risk: a signed, sandboxed lib still runs C on the MCU. Contained by
provenance (signing) + your review (you vouch) + user consent — the app-store model.

---

## 11. Data model (registry DB)

```mermaid
erDiagram
    USER ||--o{ LIBRARY : authors
    LIBRARY ||--o{ VERSION : has
    VERSION ||--o{ REVIEW : reviewed_by
    USER ||--o{ REVIEW : performs
    VERSION ||--o| SIGNATURE : signed_by
    SIGNING_KEY ||--o{ SIGNATURE : issues
    VERSION ||--o{ REVOCATION : may_have
    USER ||--o{ ENTITLEMENT : holds

    USER {
        uuid id PK
        string github_id
        string email
        string role
    }
    LIBRARY {
        uuid id PK
        string name
        string prefix
        string interface
        uuid author_id FK
        string trust_tier
    }
    VERSION {
        uuid id PK
        uuid library_id FK
        string semver
        string status
        jsonb device_json
        text driver_c
        jsonb header_spec
        jsonb capabilities
        string content_hash
    }
    REVIEW {
        uuid id PK
        uuid version_id FK
        uuid reviewer_id FK
        string decision
        jsonb findings
        timestamp reviewed_at
    }
    SIGNATURE {
        uuid id PK
        uuid version_id FK
        uuid key_id FK
        string algo
        string signature
    }
    SIGNING_KEY {
        uuid id PK
        string public_key
        string status
        timestamp rotated_at
    }
    REVOCATION {
        uuid id PK
        uuid version_id FK
        string reason
        timestamp revoked_at
    }
    ENTITLEMENT {
        uuid id PK
        uuid user_id FK
        string feature
        string status
    }
```

---

## 12. Tech stack (mirrors `lovelane`)

| Layer | Choice | Reuse from lovelane |
|---|---|---|
| API | Go, **chi** + **pgx** (no ORM), golang-migrate | `internal/domain/*`, `pkg/{apperror,response,validator,token,crypto}`, `middleware/`, `config` (caarlos0/env) |
| Auth | OAuth → JWT (HS256 access + hashed refresh + DB sessions) | `domain/auth`, `pkg/token` — add **GitHub** OAuth (dev audience) |
| DB | Postgres 16 + PgBouncer | `services/` compose |
| Jobs | asynq (Redis) for pre-screen | existing asynq wiring |
| Blobs | MinIO (or Postgres — `.vlib` are small) | `storage/minio` |
| **Signing** | **Ed25519 `pkg/sign`** — *new* | closest template: `pkg/apple/revoker.go` (PEM-from-env, sign) + `pkg/crypto/aes.go` (versioned envelope) |
| Web | Next.js App Router, Tailwind v4, shadcn/ui | `web/`, `admin/`, `store/` |
| Admin/review | next-auth + TOTP; `AdminSecret`-gated `/api/internal/admin` | `admin/` |
| Deploy | Dokploy + Traefik, per-service Dockerfile + compose | wholesale |
| **Tests/CI** | **required for sign/verify/import** | *gap in lovelane — improve here* |

---

## 13. Deployment (Dokploy + Traefik)

```mermaid
flowchart LR
    Net(("Internet")) --> TF["Traefik — TLS / Let's Encrypt"]
    subgraph Host["Dokploy host — dokploy-network"]
        TF --> WebC["registry-web :3000"]
        TF --> AdminC["registry-admin :3000"]
        TF --> APIC["registry-api :8080"]
        APIC --> PgB["PgBouncer"] --> PG[("Postgres 16")]
        APIC --> RD[("Redis + asynq")]
        APIC --> MO[("MinIO")]
        APIC --> KEY{{"Signing key<br/>Dokploy secret → sops/KMS"}}
    end
    IDEc(["Volt IDE (user machines)"]) -->|"HTTPS: browse / download / revocation"| TF
```

---

## 14. Responsibility split

```mermaid
flowchart LR
    subgraph IDEside["Volt IDE — I build this now"]
        i1["vlib-verify (Ed25519 + key-set)"]
        i2["Hardened importer"]
        i3["Consent + capability UI"]
        i4["installed-libs lockfile"]
        i5["codegen str.format fix (Python)"]
    end
    subgraph Serverside["Registry — Go + Next.js"]
        s1["Author creator + hosted test"]
        s2["Submission + pre-screen"]
        s3["Review console"]
        s4["pkg/sign + key-set + revocation"]
        s5["Marketplace + accounts"]
    end
    i5 -->|"shared validators + golden .vlib corpus"| s2
```

**Shared correctness contract:** the hardened-import validators run in **both** the Go
pre-screen and the JS importer. Bind them with a **JSON-Schema spec + a golden `.vlib`
test corpus** both must agree on — else the server signs something the IDE rejects, or
the IDE trusts something the server would have caught.

---

## 15. Prerequisite fix (do regardless)

`codegen.py` currently emits device inits via `template.format(**fmt_args)`. Python's
`str.format` is an **injection vector** (a template like `{pin.__class__…__globals__}`
can read interpreter internals at compile time). The moment third-party `device.json`
is imported, that's a live hole.

**Fix:** replace `str.format` with explicit substitution of a fixed placeholder set
(`{pin}`, `{addr}`, `{bus_id}`, `{trig}`, `{echo}`, …) and validate templates against
that allowlist on import. This lands in the IDE secure core.

---

## 16. Open decisions

1. Strip the IDE creator now, or park it until the Go generator exists (`device-creator.js` becomes the port reference)?
2. `.vlib` = single signed JSON envelope (recommended) vs archive?
3. Signing-key management: Dokploy env secret now → sops/KMS soon?
4. Capability starter set: `i2c / spi / gpio / uart / network / storage`?
5. Auth: GitHub + Google OAuth (GitHub-first)?

---

## 17. Build order

```mermaid
flowchart LR
    P0["0. codegen str.format fix"] --> P1["1. IDE secure core:<br/>vlib-verify + hardened import + consent"]
    P1 --> P2["2. .vlib spec + golden corpus<br/>(shared contract)"]
    P2 --> P3["3. registry-api:<br/>auth + library + pkg/sign"]
    P3 --> P4["4. review console + pre-screen"]
    P4 --> P5["5. registry-web:<br/>creator + hosted test + marketplace"]
    P5 --> P6["6. account-linked Install in IDE"]
    P6 --> P7["7. AI drafts (freemium) + Pro"]
```

The IDE secure core (steps 0–1) is **decision-independent** — safe to build first while
the registry stack and open decisions are settled.
