import { readFileSync } from "node:fs";

import { verifyManifest, type VerifyOptions } from "../src/lib/domain/manifest";

/**
 * Check a run manifest without a database, a server or this codebase's trust.
 *
 *   tsx scripts/verify-manifest.ts run-manifest.json
 *   tsx scripts/verify-manifest.ts run-manifest.json --chain audit.json
 *
 * The chain file is `[{ "seq": 12, "hash": "…" }]` (or `{ "events": [...] }`)
 * copied from wherever the audit chain is kept. Without it the anchor is
 * reported as unchecked — never as verified.
 *
 * Exit 0 = every check that could run passed, 1 = a mismatch, 2 = the input
 * could not be read or parsed. Anything but 0 must fail a pipeline.
 */
function usage(): never {
  console.error("usage: verify-manifest <manifest.json> [--chain <chain.json>]");
  process.exit(2);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error("cannot read " + path + ": " + (error as Error).message);
    process.exit(2);
  }
}

function readChain(path: string): { seq: number; hash: string }[] {
  const parsed = readJson(path);
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : null;
  if (!list) {
    console.error("chain file must be an array of {seq, hash} or {'events': [...]}");
    process.exit(2);
  }
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as { seq?: unknown; hash?: unknown };
    if (typeof row.seq !== "number" || typeof row.hash !== "string") return [];
    return [{ seq: row.seq, hash: row.hash }];
  });
}

const argv = process.argv.slice(2);
const manifestPath = argv.find((arg) => !arg.startsWith("--"));
if (!manifestPath) usage();

const chainFlag = argv.indexOf("--chain");
const chainPath = chainFlag === -1 ? null : argv[chainFlag + 1];
if (chainFlag !== -1 && !chainPath) usage();

const options: VerifyOptions = chainPath ? { chain: readChain(chainPath) } : {};
const result = verifyManifest(readJson(manifestPath), options);

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
