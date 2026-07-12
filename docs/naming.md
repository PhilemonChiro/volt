# Volt platform — naming

The parts are named on an **electrical theme** (Volt is electricity), and each name
**hints at its function**. Read together they trace a **circuit** — the same path a
library travels through the system:

```
   Spark  ──▶  Gate  ──▶  Grid  ──▶  Fuse  ──▶  device
  (create)  (review)  (distribute) (protect on entry)
```

A library is *sparked* in the studio, passes the *gate*, joins the *grid*, and
enters a device through the *fuse*. The name is the architecture.

## The names

| Name | What it is | Maps to | Tagline |
|---|---|---|---|
| **Spark** | Web authoring studio (create, test, submit) | `registry-web` (Next.js) | *create, test, submit a library* |
| **Gate** | Review / moderation console | `registry-api` admin routes + admin console | *curate before publish* |
| **Grid** | Library registry / marketplace | `registry-api` + storage | *where Volt libraries are distributed* |
| **Fuse** | The IDE's secure import + install | `vlib-verify.js` + `vlib-import.js` in the IDE | *verifies and contains every library before your device* |
| **Cell** | The signed **`.vcell`** package | the signed JSON envelope | *a signed, self-contained library* |
| **Bench** | Hosted simulator / test | Wokwi/QEMU hosted build+run | *run it before you flash it* |
| **Arc** | Compiler (Volt → C) | `voltc` / `codegen.py` | *turns Volt into firmware* |

Pillars: **Grid / Fuse / Spark**. The rest are features/sub-brands.

## Principles
- **Theme + function** — electrical, and the name tells you what the thing does.
- **Name what people touch** — services and user-facing parts, not every internal
  library. Over-naming internals creates confusion, not clarity.
- **The set is a system** — new names should fit the circuit metaphor and the
  electrical theme, and preferably read as a verb ("fuse it", "publish to the grid",
  "spark a library", "gate it", "bench it").

## Trademark note
`Grid`, `Spark`, and `Fuse` are common words (trademark-crowded). Two-tier naming:

- **Internal / architecture vocabulary:** the bare names — `Grid`, `Fuse`, `Spark`,
  `Gate`, `Bench`, `Cell`. Used in code, docs, and conversation.
- **Public / registrable marks:** the **`Volt`-prefixed** forms — **VoltGrid**,
  **VoltFuse**, **VoltSpark** — which carry the brand family and are far more
  registrable than the common words alone.
