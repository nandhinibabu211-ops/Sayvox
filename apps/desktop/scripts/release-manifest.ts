/* eslint-disable no-console -- CLI script */
/**
 * Writes the Tauri updater manifest `latest.json` for a release (Story 5.3 / T082-T083).
 *
 *   node scripts/release-manifest.ts --version 0.2.0 --sig <setup.exe.sig> \
 *     --url https://storage.googleapis.com/<bucket>/releases/v0.2.0/Sayvox_0.2.0_x64-setup.exe \
 *     --out latest.json [--notes "…"]
 *
 * The signature is the minisign signature Tauri writes next to the updater bundle when
 * `createUpdaterArtifacts` is on; the client refuses any package it doesn't verify.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function buildManifest(o: {
  version: string;
  signature: string;
  url: string;
  notes?: string;
  now?: Date;
}): Manifest {
  if (!SEMVER.test(o.version)) throw new Error(`not a version: ${o.version}`);
  const signature = o.signature.trim();
  if (!signature) throw new Error("empty signature");
  const url = new URL(o.url);
  if (url.protocol !== "https:") throw new Error("update URL must be https");
  if (!url.pathname.includes(o.version)) throw new Error("update URL doesn't name this version");
  return {
    version: o.version,
    notes: o.notes ?? `Sayvox ${o.version}`,
    pub_date: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "windows-x86_64": { signature, url: url.toString() } },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      sig: { type: "string" },
      url: { type: "string" },
      out: { type: "string", default: "latest.json" },
      notes: { type: "string" },
    },
  });
  if (!values.version || !values.sig || !values.url) {
    console.error("usage: release-manifest.ts --version X --sig FILE --url URL [--out FILE]");
    process.exit(2);
  }
  const manifest = buildManifest({
    version: values.version,
    signature: readFileSync(values.sig, "utf8"),
    url: values.url,
    ...(values.notes ? { notes: values.notes } : {}),
  });
  writeFileSync(values.out!, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${values.out} for ${manifest.version}`);
}
