// Collects relevant jobs from every company in data/companies.json and writes
// docs/data/jobs.json, which is all the site needs to load.
// Also resolves company names the site queued in data/requests.json.

import { readFile, writeFile } from 'node:fs/promises';
import { fetchCompany, pool } from '../docs/lib/sources.js';
import { discover } from './discover.mjs';
import { collectLinkedIn } from './linkedin.mjs';

const file = (p) => new URL(`../${p}`, import.meta.url);
const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(file(p), 'utf8')); } catch { return fallback; }
};
const writeJson = (p, data, indent) => writeFile(file(p), JSON.stringify(data, null, indent) + '\n');

const companies = await readJson('data/companies.json', []);
const requests = await readJson('data/requests.json', []);
const previous = await readJson('docs/data/jobs.json', { jobs: [] });
const now = new Date().toISOString();

// Company names typed into the site that it could not find by itself.
for (const request of requests.filter((r) => r.status === 'pending')) {
  const hit = await discover(request.name, request.url);
  request.checkedAt = now;
  if (!hit) { request.status = 'not_found'; continue; }
  request.status = 'found';
  request.israel = hit.israel;
  request.relevant = hit.jobs.length;
  request.board = `${hit.company.ats}/${hit.company.slug}`;
  if (!companies.some((c) => c.ats === hit.company.ats && c.slug === hit.company.slug)) companies.push(hit.company);
  console.log(`request "${request.name}": ${request.board}, ${request.relevant} relevant jobs`);
}
companies.sort((a, b) => a.name.localeCompare(b.name));

const firstSeen = new Map(previous.jobs.map((j) => [j.id, j.firstSeen]));
const previousByCompany = Map.groupBy(previous.jobs, (j) => j.company);
const jobs = [];
const failed = [];

await pool(companies, 12, async (company) => {
  try {
    const result = await fetchCompany(company);
    jobs.push(...result.jobs);
  } catch (err) {
    // A board that is down for one run keeps the jobs it had last time.
    failed.push(`${company.name}: ${err.message}`);
    jobs.push(...(previousByCompany.get(company.name) || []));
  }
});

// LinkedIn covers companies without a board of their own. A posting that also
// came straight from the company's board is kept only once, from the board.
const linkedin = await collectLinkedIn(previous.jobs, await readJson('data/linkedin-cache.json', {}));
// Compared by the company's first word, since LinkedIn names differ slightly
// ("Amazon Web Services (AWS)" vs "Amazon"). This also folds the copies
// LinkedIn lists per city into one.
const sameJob = (j) => `${j.company.trim().split(/s+/)[0]}|${j.title}`.toLowerCase().replace(/[^a-z0-9א-ת|]/g, '');
const taken = new Set(jobs.map(sameJob));
for (const job of linkedin.jobs) {
  if (taken.has(sameJob(job))) continue;
  taken.add(sameJob(job));
  jobs.push(job);
}
if (!linkedin.ok) failed.push('LinkedIn: no answer, kept the previous results');

const unique = [...new Map(jobs.map((j) => [j.id, j])).values()];
for (const job of unique) job.firstSeen = firstSeen.get(job.id) || now;
unique.sort((a, b) => (b.posted || b.firstSeen).localeCompare(a.posted || a.firstSeen));

await writeJson('docs/data/jobs.json', { generatedAt: now, companies: companies.length, jobs: unique });
await writeJson('data/companies.json', companies, 1);
await writeJson('data/requests.json', requests, 1);
await writeJson('data/linkedin-cache.json', linkedin.cache);

console.log(`${unique.length} jobs from ${companies.length} companies (${failed.length} failed)`);
for (const f of failed) console.log(`  failed: ${f}`);
