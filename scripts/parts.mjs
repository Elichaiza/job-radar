// The workflow runs the LinkedIn and careers-page collectors as several shards
// on separate machines; each writes a part file, and collect.mjs merges them.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const file = (p) => new URL(`../${p}`, import.meta.url);

export async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(file(p), 'utf8')); } catch { return fallback; }
}

export async function writePart(out, part) {
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(part));
}

// Merges <dir>/<kind>-0.json ... <kind>-<shards-1>.json into what the
// collector itself returns: { jobs, cache, ok }. A shard that left no part
// (its machine failed) keeps all the previous jobs of that source, since
// there is no telling which of them it would have found again.
export async function readParts(dir, kind, shards, previous, cache) {
  const parts = [];
  for (let i = 0; i < shards; i++) {
    try { parts.push(JSON.parse(await readFile(path.join(dir, `${kind}-${i}.json`), 'utf8'))); } catch { /* missing */ }
  }
  const jobs = new Map(parts.flatMap((p) => p.jobs).map((j) => [j.id, j]));
  if (parts.length < shards) for (const j of previous) if (!jobs.has(j.id)) jobs.set(j.id, j);
  return {
    jobs: [...jobs.values()],
    cache: parts.length ? Object.assign({}, ...parts.map((p) => p.cache)) : cache,
    ok: parts.some((p) => p.ok !== false),
    missing: shards - parts.length,
  };
}
