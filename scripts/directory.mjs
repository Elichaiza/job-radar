// A long list of Israeli companies (data/directory.json: { name, slug, label },
// slug being the company's LinkedIn name) that no other list here knows. Each
// is looked for once: on its own website when one goes by its name, and on
// the job boards by its name. A company is added to data/companies.json only
// if a board with postings in Israel is found; from then on the collector
// reads it like any other. Companies with nothing found are tried again after
// RETRY_DAYS. This runs in its own workflow (directory.yml), not with every collection.
//
//   SHARD=i/n node scripts/directory.mjs --out parts/directory-i.json
//   node scripts/directory.mjs --merge parts

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findCompany, pool } from '../docs/lib/sources.js';
import { discover } from './discover.mjs';
import { readJson, writePart } from './parts.mjs';
import { normName } from './sites.mjs';

const RETRY_DAYS = 60;
const MINUTES = 45;
const [SHARD, SHARDS] = (process.env.SHARD || '0/1').split('/').map(Number);
// Industries most likely to hire developers go first.
const FIRST = /cyber|software|internet|data|it|security|fintech|crypto|gaming|hardware|telecom|defense|hr/i;

async function search(out) {
  const directory = await readJson('data/directory.json', []);
  const known = new Set([
    ...await readJson('data/companies.json', []),
    ...await readJson('data/career-pages.json', []),
  ].map((c) => normName(c.name)));
  const checked = await readJson('data/directory-cache.json', {});
  const cutoff = Date.now() - RETRY_DAYS * 86400000;
  const todo = directory
    .filter((c) => normName(c.name).length >= 2 && !known.has(normName(c.name)))
    .filter((c) => !checked[normName(c.name)] || new Date(checked[normName(c.name)]) < cutoff)
    .sort((a, b) => FIRST.test(b.label) - FIRST.test(a.label))
    .filter((_, i) => i % SHARDS === SHARD);

  const deadline = Date.now() + MINUTES * 60000;
  const now = new Date().toISOString();
  const companies = [];
  const cache = {};
  let tried = 0;
  await pool(todo, 12, async ({ name, slug }) => {
    if (Date.now() > deadline || !/[a-z]/i.test(name)) return;
    tried++;
    let hit = await discover(name, undefined, 4).catch(() => null);
    // The LinkedIn name is often the board's name too.
    const linkedin = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!hit && linkedin.length >= 3) hit = await findCompany(linkedin, undefined, 2).catch(() => null);
    cache[normName(name)] = now;
    if (!hit) return;
    const { ats, slug: board, token } = hit.company;
    companies.push(token ? { name, ats, slug: board, token } : { name, ats, slug: board });
    console.log(`+ ${name}: ${ats}/${board}, ${hit.israel} in Israel, ${hit.jobs.length} relevant`);
  });
  console.log(`directory ${SHARD + 1}/${SHARDS}: ${todo.length} to check, ${tried} checked, ${companies.length} boards found`);
  await writePart(out, { companies, cache });
}

async function merge(dir) {
  const companies = await readJson('data/companies.json', []);
  const cache = await readJson('data/directory-cache.json', {});
  const boards = new Set(companies.map((c) => `${c.ats}/${c.slug}`));
  const names = new Set(companies.map((c) => normName(c.name)));
  let added = 0;
  for (const f of (await readdir(dir)).filter((f) => /^directory-\d+\.json$/.test(f))) {
    const part = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    Object.assign(cache, part.cache);
    for (const c of part.companies) {
      if (boards.has(`${c.ats}/${c.slug}`) || names.has(normName(c.name))) continue;
      boards.add(`${c.ats}/${c.slug}`);
      names.add(normName(c.name));
      companies.push(c);
      added++;
    }
  }
  companies.sort((a, b) => a.name.localeCompare(b.name));
  const file = (p) => new URL(`../${p}`, import.meta.url);
  await writeFile(file('data/companies.json'), JSON.stringify(companies, null, 1) + '\n');
  await writeFile(file('data/directory-cache.json'), JSON.stringify(cache, null, 1) + '\n');
  console.log(`directory: ${added} companies added, ${companies.length} in all`);
}

const arg = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv[i + 1]; };
if (arg('--merge')) await merge(arg('--merge'));
else await search(arg('--out') || 'parts/directory-0.json');
