#!/usr/bin/env node
/* tpl_fetch.js — decrypt + gate the frozen Profit Planner engine (g0).
 *
 * Usage:  node tpl_fetch.js <template.html> <template.manifest.json> <out_plaintext.html> [password]
 *   - <template.html>: the StatiCrypt-encrypted frozen engine from the repo
 *     (repo Profit-Planner/template.html — fetched via Contents API when
 *     api.github.com is reachable, else from the authenticated git clone).
 *   - password defaults to the shared site password if not passed.
 *
 * Gates (ALL must pass — any failure exits 1 and prints g0:FAIL + reason):
 *   g0a  sha256 of decrypted plaintext === manifest.plaintext_sha256
 *   g0b  manifest.engine_v appears verbatim in the plaintext
 *   g0c  exactly manifest.markers splice markers of form /*<<DATA:NAME>>*​/
 *   g0d  length matches manifest — accepts plaintext_utf8_bytes OR
 *        plaintext_chars OR legacy plaintext_bytes matching either measure.
 *
 * Decryption uses the staticrypt package's OWN crypto engine
 * (require staticrypt/lib/cryptoEngine.js) — zero reimplementation.
 * Requires `npm install staticrypt` in the CWD (same install as publish 6a).
 */
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

async function main() {
    const [tplPath, manPath, outPath, passArg] = process.argv.slice(2);
    if (!tplPath || !manPath || !outPath) {
        console.error("usage: node tpl_fetch.js <template.html> <manifest.json> <out.html> [password]");
        process.exit(1);
    }
    const password = passArg || "winbranchoftheyear";
    const engine = require(path.resolve("node_modules/staticrypt/lib/cryptoEngine.js"));
    const codec = require(path.resolve("node_modules/staticrypt/lib/codec.js")).init(engine);

    const html = fs.readFileSync(tplPath, "utf8");
    const manifest = JSON.parse(fs.readFileSync(manPath, "utf8"));

    // Extract staticryptEncryptedMsgUniqueVariableName + salt from the wrapper.
    const msgMatch = html.match(/staticryptEncryptedMsgUniqueVariableName["']?\s*:\s*["']([0-9a-fA-F]+)["']/);
    const saltMatch = html.match(/staticryptSaltUniqueVariableName["']?\s*:\s*["']([0-9a-fA-F]+)["']/);
    if (!msgMatch || !saltMatch) fail("wrapper parse — staticrypt payload/salt not found");
    const hashed = await engine.hashPassword(password, saltMatch[1]);
    // codec.decode = staticrypt's own HMAC-verify + decrypt path (same as the browser).
    const res = await codec.decode(msgMatch[1], hashed, saltMatch[1]);
    if (!res.success) fail("decrypt failed — wrong password/salt or corrupted payload: " + res.message);
    const plain = res.decoded;

    // g0a — sha256
    const sha = crypto.createHash("sha256").update(plain, "utf8").digest("hex");
    if (sha !== manifest.plaintext_sha256) fail(`g0a sha256 mismatch: got ${sha}, manifest ${manifest.plaintext_sha256}`);

    // g0b — engine revision string present in plaintext
    if (!manifest.engine_v || plain.indexOf(manifest.engine_v) === -1) fail(`g0b engine_v ${manifest.engine_v} not found in plaintext`);

    // g0c — marker count
    const markers = plain.match(/\/\*<<DATA:[A-Z]+>>\*\//g) || [];
    if (markers.length !== manifest.markers) fail(`g0c marker count ${markers.length} != manifest ${manifest.markers}`);

    // g0d — length (chars or utf8 bytes; legacy plaintext_bytes accepted as either)
    const chars = plain.length, bytes = Buffer.byteLength(plain, "utf8");
    const okLen =
        (manifest.plaintext_chars ? manifest.plaintext_chars === chars : false) ||
        (manifest.plaintext_utf8_bytes ? manifest.plaintext_utf8_bytes === bytes : false) ||
        (manifest.plaintext_bytes ? (manifest.plaintext_bytes === chars || manifest.plaintext_bytes === bytes) : false);
    if (!okLen) fail(`g0d length mismatch: chars ${chars} / utf8 ${bytes} vs manifest ${JSON.stringify({c: manifest.plaintext_chars, b: manifest.plaintext_utf8_bytes, legacy: manifest.plaintext_bytes})}`);

    fs.writeFileSync(outPath, plain);
    console.log(JSON.stringify({ g0: "PASS", engine_v: manifest.engine_v, sha256: sha, chars, utf8_bytes: bytes, markers: markers.length, out: outPath }));
}

function fail(reason) {
    console.error(JSON.stringify({ g0: "FAIL", reason }));
    process.exit(1);
}

main().catch((e) => fail("unexpected: " + e.message));
