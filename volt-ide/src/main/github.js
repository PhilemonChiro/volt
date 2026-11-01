// github.js — the GitHub panel's back end: sign in with GitHub (device flow,
// token kept encrypted with the OS keychain), and git for the open project:
// status, commit and push, pull, and publishing a project as a new repo.
// Git runs as the system `git`; pushes and pulls get the token through
// GIT_ASKPASS, so it is never written into the repo's config or a URL.

const { safeStorage } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logger = require("./logger");

const DIR = path.join(os.homedir(), ".volt");
const TOKEN_FILE = path.join(DIR, "github.bin");
const ASKPASS = path.join(DIR, "git-askpass.sh");

let sendToRenderer = () => {};
let getSetting = () => undefined;
let pending = null; // device-flow sign-in in progress: { cancelled }

function init({ send, setting }) {
    sendToRenderer = send;
    getSetting = setting;
}

// Volt's GitHub OAuth app — the one Grid and Spark sign in with — with device
// flow enabled. The client ID is public; no secret is needed for device flow.
// $VOLT_GITHUB_CLIENT_ID or Settings → github.clientId override it.
const VOLT_GITHUB_APP = "Ov23liMW366cJYhum3ia";
function clientId() {
    return process.env.VOLT_GITHUB_CLIENT_ID || getSetting("github.clientId") || VOLT_GITHUB_APP;
}

// ---- account ----

function readAccount() {
    try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(TOKEN_FILE)));
    } catch { return null; }
}
function writeAccount(acc) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, safeStorage.encryptString(JSON.stringify(acc)), { mode: 0o600 });
}

async function api(token, method, url, body) {
    const res = await fetch(url.startsWith("http") ? url : "https://api.github.com" + url, {
        method,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Volt-IDE",
            ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const why = data.errors && data.errors[0] && (data.errors[0].message || data.errors[0].code);
        throw new Error(why || data.message || `GitHub answered ${res.status}`);
    }
    return data;
}

/** status() → {configured, signedIn, login, name, avatar} */
async function status() {
    const acc = readAccount();
    return { configured: !!clientId(), signedIn: !!acc, login: acc && acc.login, name: acc && acc.name, avatar: acc && acc.avatar };
}

/** signIn() → {userCode, uri}; finishes in the background ("github:event"). */
async function signIn() {
    const id = clientId();
    if (!id) throw new Error("Volt's GitHub app isn't set up yet (github.clientId).");
    if (pending) pending.cancelled = true;
    const res = await fetch("https://github.com/login/device/code", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: id, scope: "repo" }),
    });
    const d = await res.json();
    if (!d.device_code) throw new Error(d.error_description || d.error || "GitHub didn't start the sign-in.");
    const job = { cancelled: false };
    pending = job;
    // The panel shows the code first; the user opens GitHub from there.
    poll(job, id, d).catch(e => sendToRenderer("github:event", { t: "error", text: e.message }));
    return { userCode: d.user_code, uri: d.verification_uri, expiresIn: d.expires_in };
}

async function poll(job, id, d) {
    let wait = (d.interval || 5) * 1000;
    const until = Date.now() + (d.expires_in || 900) * 1000;
    while (!job.cancelled && Date.now() < until) {
        await new Promise(r => setTimeout(r, wait));
        if (job.cancelled) return;
        const res = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: id, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        });
        const t = await res.json();
        if (t.access_token) {
            const u = await api(t.access_token, "GET", "/user");
            writeAccount({ token: t.access_token, login: u.login, name: u.name || u.login, id: u.id, avatar: u.avatar_url });
            pending = null;
            logger.log("info", "github", `signed in as ${u.login}`);
            sendToRenderer("github:event", { t: "signed-in", login: u.login });
            return;
        }
        if (t.error === "slow_down") wait += 5000;
        else if (t.error !== "authorization_pending") throw new Error(t.error === "access_denied" ? "Sign-in was cancelled on GitHub." : t.error_description || t.error);
    }
    if (!job.cancelled) throw new Error("The sign-in code expired. Try again.");
}

function cancelSignIn() { if (pending) pending.cancelled = true; pending = null; }

function signOut() {
    cancelSignIn();
    try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
}

// ---- git ----

function askpass() {
    const text = '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) echo "$VOLT_GH_TOKEN" ;;\nesac\n';
    try { if (fs.readFileSync(ASKPASS, "utf8") === text) return ASKPASS; } catch (_) {}
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ASKPASS, text, { mode: 0o700 });
    return ASKPASS;
}

// git(project, args, {auth}) → {ok, out, err}. With auth, the token answers
// git's credential prompt (and no stored helper is consulted).
function git(project, args, { auth = false } = {}) {
    const acc = auth ? readAccount() : null;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    let pre = [];
    if (acc) {
        Object.assign(env, { GIT_ASKPASS: askpass(), VOLT_GH_TOKEN: acc.token });
        pre = ["-c", "credential.helper="];
    }
    return new Promise((resolve) => execFile("git", [...pre, ...args], { cwd: project, env, timeout: 120000, maxBuffer: 8 << 20 },
        (e, out, err) => resolve({ ok: !e, out: String(out || ""), err: String(err || (e && e.message) || "").trim() })));
}

// Commits are made as the user: their git identity, or else their GitHub one.
async function identity(project) {
    const name = (await git(project, ["config", "user.name"])).out.trim();
    const email = (await git(project, ["config", "user.email"])).out.trim();
    if (name && email) return [];
    const acc = readAccount();
    if (!acc) return [];
    return ["-c", `user.name=${name || acc.name}`, "-c", `user.email=${email || `${acc.id}+${acc.login}@users.noreply.github.com`}`];
}

function githubRepo(url) {
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url || "");
    return m ? { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// Volt's automatic History keeps a private git store in .volt/history and
// leaves a ".git" file pointing at it. That isn't the user's repository:
// treat the project as having none until they publish it.
function historyPointer(project) {
    try {
        const p = path.join(project, ".git");
        return fs.statSync(p).isFile() && /gitdir:\s*\.volt[\\/]history/.test(fs.readFileSync(p, "utf8"));
    } catch { return false; }
}

// The files a first publish would include: everything but the build output,
// Volt's own folder, git's, and hidden files (what .gitignore leaves out).
function projectFiles(project) {
    const out = [];
    const walk = (dir, rel, depth) => {
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of names) {
            if (d.name.startsWith(".") && d.name !== ".gitignore") continue;
            if (!rel && (d.name === "build" || d.name === "node_modules")) continue;
            const r = rel ? rel + "/" + d.name : d.name;
            if (d.isDirectory()) { if (depth < 4) walk(path.join(dir, d.name), r, depth + 1); }
            else out.push(r);
            if (out.length >= 200) return;
        }
    };
    walk(project, "", 0);
    return out.sort();
}

/** repo(project) → {isRepo, branch, remote, ahead, behind, changes:[{path, status}]} */
async function repo(project) {
    if (!project) return { isRepo: false };
    if (historyPointer(project) || !fs.existsSync(path.join(project, ".git"))) return { isRepo: false, files: projectFiles(project) };
    const top = await git(project, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) return { isRepo: false };
    const st = await git(project, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
    const lines = st.out.split("\n").filter(Boolean);
    const head = (lines.shift() || "").replace(/^## /, "");
    const branch = head.split("...")[0].replace(/^No commits yet on /, "");
    const ahead = +((/ahead (\d+)/.exec(head) || [])[1] || 0);
    const behind = +((/behind (\d+)/.exec(head) || [])[1] || 0);
    const changes = lines.map(l => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).replace(/^"|"$/g, "") }));
    const remote = githubRepo((await git(project, ["remote", "get-url", "origin"])).out.trim());
    const hasCommits = (await git(project, ["rev-parse", "--verify", "HEAD"])).ok;
    const upstream = /\.\.\./.test(head);
    return { isRepo: true, root: top.out.trim(), branch, ahead, behind, upstream, changes, remote, hasCommits };
}

/** diff(project) → what changed since the last commit, as text for a commit message:
 *  the diff of tracked files plus the contents of new ones (small, readable). */
async function diff(project) {
    const r = await repo(project);
    if (!r.isRepo) return "";
    const parts = [];
    const d = await git(project, ["diff", ...(r.hasCommits ? ["HEAD"] : ["--cached"]), "--no-color", "--unified=2"]);
    if (d.out.trim()) parts.push(d.out);
    for (const c of r.changes.filter(c => c.status.startsWith("?")).slice(0, 10)) {
        let body = "";
        try { body = fs.readFileSync(path.join(project, c.path), "utf8").slice(0, 3000); } catch (_) {}
        parts.push(`New file ${c.path}:\n${body}`);
    }
    return parts.join("\n\n").slice(0, 14000);
}

/** commit(project, message, push) — stage everything, commit, then push. */
async function commit(project, message, push = true) {
    message = String(message || "").trim();
    if (!message) throw new Error("Write a message that says what changed.");
    const r = await repo(project);
    if (!r.isRepo) throw new Error("This project isn't a git repository yet. Publish it first.");
    if (r.changes.length) {
        let a = await git(project, ["add", "-A"]);
        if (!a.ok) throw new Error(a.err);
        a = await git(project, [...await identity(project), "commit", "-m", message]);
        if (!a.ok) throw new Error(a.err || a.out);
    }
    if (push) await pushBranch(project, r);
    return repo(project);
}

async function pushBranch(project, r) {
    if (!r.remote) throw new Error("No GitHub remote. Publish the project first.");
    const p = await git(project, ["push", ...(r.upstream ? [] : ["-u", "origin", r.branch])], { auth: true });
    if (!p.ok) {
        if (/rejected|non-fast-forward|fetch first/i.test(p.err)) throw new Error("GitHub has changes you don't have yet. Pull first, then push.");
        throw new Error(cleanGitError(p.err));
    }
}

/** pull(project) — fast-forward to GitHub's version of the branch. */
async function pull(project) {
    const r = await repo(project);
    if (!r.remote) throw new Error("No GitHub remote.");
    if (r.changes.length) throw new Error("Commit your changes first, then pull.");
    const p = await git(project, ["pull", "--ff-only", "origin", r.branch], { auth: true });
    if (!p.ok) {
        if (/diverg|not possible to fast-forward/i.test(p.err)) throw new Error("Your commits and GitHub's have diverged. Resolve it with git in a terminal.");
        throw new Error(cleanGitError(p.err));
    }
    return repo(project);
}

/** publish(project, {name, private, description}) — a new GitHub repo with the project in it. */
async function publish(project, opts = {}) {
    const acc = readAccount();
    if (!acc) throw new Error("Sign in to GitHub first.");
    const name = String(opts.name || "").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Use letters, numbers, dots, dashes and underscores for the repository name.");
    let r = await repo(project);
    if (r.remote) throw new Error(`Already on GitHub: ${r.remote.url}`);
    const created = await api(acc.token, "POST", "/user/repos", { name, private: opts.private !== false,
        description: String(opts.description || "").slice(0, 300), auto_init: false });
    if (!r.isRepo) {
        // History reads its own store directly; the pointer file can go.
        if (historyPointer(project)) fs.unlinkSync(path.join(project, ".git"));
        const i = await git(project, ["init", "-b", "main"]);
        if (!i.ok) throw new Error(i.err);
    }
    if (!fs.existsSync(path.join(project, ".gitignore"))) fs.writeFileSync(path.join(project, ".gitignore"), "build/\n.volt/\n");
    r = await repo(project);
    if (r.changes.length || !r.hasCommits) {
        await git(project, ["add", "-A"]);
        const c = await git(project, [...await identity(project), "commit", "-m", "First commit"]);
        if (!c.ok && !/nothing to commit/.test(c.out + c.err)) throw new Error(c.err || c.out);
    }
    const add = await git(project, ["remote", "add", "origin", created.clone_url]);
    if (!add.ok) throw new Error(add.err);
    r = await repo(project);
    await pushBranch(project, r);
    logger.log("info", "github", `published ${created.full_name}`);
    return repo(project);
}

function cleanGitError(text) {
    const line = String(text || "").split("\n").map(s => s.replace(/^(fatal|error|remote):\s*/i, "").trim()).filter(Boolean).pop();
    return line || "git failed";
}

module.exports = { init, status, signIn, cancelSignIn, signOut, repo, diff, commit, pull, publish };
