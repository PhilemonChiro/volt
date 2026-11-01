#!/usr/bin/env node
// Rewrite electron-builder's latest.yml for an installer whose bytes changed
// after it was written (code signing does that). Installed IDEs check the
// sha512 and size before applying an update, so a stale hash would make every
// Windows update fail. The block map no longer matches either, so
// blockMapSize is dropped: electron-updater then downloads the full installer
// instead of a differential update.
//
//   node scripts/update-feed-hash.js dist/latest.yml "release/Volt IDE Setup X.exe" > release/latest.yml

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [feedPath, installer] = process.argv.slice(2);
if (!feedPath || !installer) {
    console.error("usage: update-feed-hash.js <latest.yml> <installer.exe>");
    process.exit(2);
}
const bytes = fs.readFileSync(installer);
const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
const name = path.basename(installer);

let found = false;
const out = [];
let inEntry = false;
for (const line of fs.readFileSync(feedPath, "utf-8").split("\n")) {
    const url = line.match(/^\s+- url: (.+)$/);
    if (url) {
        inEntry = url[1].trim() === name;
        found ||= inEntry;
        out.push(line);
        continue;
    }
    if (inEntry && /^\s+sha512: /.test(line)) { out.push(line.replace(/sha512: .*/, `sha512: ${sha512}`)); continue; }
    if (inEntry && /^\s+size: /.test(line)) { out.push(line.replace(/size: .*/, `size: ${bytes.length}`)); continue; }
    if (inEntry && /^\s+blockMapSize: /.test(line)) continue;
    if (/^\S/.test(line)) inEntry = false;
    if (/^sha512: /.test(line)) { out.push(`sha512: ${sha512}`); continue; }
    out.push(line);
}
if (!found) {
    console.error(`update-feed-hash: ${name} is not listed in ${feedPath}`);
    process.exit(1);
}
process.stdout.write(out.join("\n"));
