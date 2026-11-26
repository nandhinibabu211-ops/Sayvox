/* eslint-disable no-console -- CLI script */
// Verify a Tauri updater signature (minisign format) against the public key in
// tauri.conf.json, using only Node's crypto. Used by .github/workflows/updater-key-check.yml
// to prove the GitHub signing secrets match the shipped public key, before any release.
//
//   node apps/desktop/scripts/verify-updater-signature.mjs <file> <file.sig> [pubkey-base64]
//
// The public key defaults to plugins.updater.pubkey in apps/desktop/src-tauri/tauri.conf.json.
// Prints only key ids and pass/fail; exits 1 on any mismatch.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [file, sigFile, pubArg] = process.argv.slice(2);
if (!file || !sigFile) {
  console.error("usage: verify-updater-signature.mjs <file> <file.sig> [pubkey-base64]");
  process.exit(2);
}

const confPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const pubB64 = pubArg ?? JSON.parse(readFileSync(confPath, "utf8")).plugins.updater.pubkey;

// Both the public key and the .sig file are base64 of a minisign text file:
// "untrusted comment: ...\n<base64 payload>\n[trusted comment: ...\n<base64 global sig>]"
const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").trim().split(/\r?\n/);

const pubLines = lines(pubB64);
const pub = Buffer.from(pubLines[1], "base64"); // "Ed" | key id (8) | key (32)
if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed")
  throw new Error("not a minisign Ed25519 public key");
const pubId = pub.subarray(2, 10);

const sigLines = lines(readFileSync(sigFile, "utf8"));
const sig = Buffer.from(sigLines[1], "base64"); // "Ed"/"ED" | key id (8) | signature (64)
if (sig.length !== 74) throw new Error("not a minisign signature");
const alg = sig.subarray(0, 2).toString();
const sigId = sig.subarray(2, 10);
const hexId = (b) => Buffer.from(b).reverse().toString("hex").toUpperCase();

console.log(`public key id ${hexId(pubId)}, signature key id ${hexId(sigId)}, algorithm ${alg}`);
if (!pubId.equals(sigId)) {
  console.log("FAIL: the signing key is not the one whose public key is in tauri.conf.json");
  process.exit(1);
}

const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]),
  format: "der",
  type: "spki",
});
const data = readFileSync(file);
// "ED" = pre-hashed (BLAKE2b-512 of the file), "Ed" = the file itself.
const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
const ok = verify(null, message, key, sig.subarray(10));

// The trusted comment is signed too (global signature over signature || comment).
let globalOk = true;
if (sigLines.length >= 4 && sigLines[2].startsWith("trusted comment: ")) {
  const comment = Buffer.from(sigLines[2].slice("trusted comment: ".length));
  globalOk = verify(
    null,
    Buffer.concat([sig.subarray(10), comment]),
    key,
    Buffer.from(sigLines[3], "base64"),
  );
}

const which = pubArg ? "the given public key" : "the public key in tauri.conf.json";
console.log(
  ok && globalOk ? `PASS: signature verifies with ${which}` : "FAIL: signature does not verify",
);
process.exit(ok && globalOk ? 0 : 1);
