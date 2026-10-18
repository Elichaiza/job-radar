// Finds which job board a company uses.
//   node scripts/discover.mjs "Company A" "Company B"     -> prints what it found
//   node scripts/discover.mjs --seed names.json           -> merges results into data/companies.json
// names.json is a list of { name, careers_url? }.

import { readFile, writeFile } from 'node:fs/promises';
import { fetchCompany, findCompany, pool, BROWSER_ATS } from '../docs/lib/sources.js';

const COMPANIES_FILE = new URL('../data/companies.json', import.meta.url);

const FINGERPRINTS = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([\w-]+)/i, (m) => m[1]],
  ['lever', /jobs\.lever\.co\/([\w-]+)/i, (m) => m[1]],
  ['ashby', /jobs\.ashbyhq\.com\/([\w.-]+)/i, (m) => m[1]],
  ['smartrecruiters', /(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/i, (m) => m[1]],
  ['workday', /([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/i, (m) => `${m[1]}.${m[2]}/${m[3]}`],
];
const NOT_A_SLUG = /^(embed|js|v1|api|jobs|job|search|careers|company|static|assets|images|wday|en-us)$/i;

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    // The final address matters too: many careers pages just redirect to the board.
    return `${res.url}\n${await res.text()}`;
  } catch { return ''; }
}

const COMEET_TOKEN = /["']?token["']?\s*[:=]\s*["']([0-9A-F]{16,})["']/;

// The job boards a page links to or embeds: [{ ats, slug, token? }].
export async function fingerprint(html) {
  const found = [];
  for (const [ats, re, toSlug] of FINGERPRINTS) {
    const m = html.match(re);
    if (m && !NOT_A_SLUG.test(m[1])) found.push({ ats, slug: toSlug(m) });
  }
  // Comeet, embedded widget: the page carries the company uid and token.
  const widget = html.match(/COMEET\.init\(\{[\s\S]{0,800}/);
  const uid = widget?.[0].match(/["']?company-uid["']?\s*:\s*["']([\w.]+)["']/);
  const token = widget?.[0].match(COMEET_TOKEN);
  if (uid && token) found.push({ ats: 'comeet', slug: uid[1], token: token[1] });
  // Comeet, hosted page: the token is on that page.
  const hosted = html.match(/comeet\.com?\/jobs\/([\w-]+)\/(\w+\.\w+)/i);
  if (hosted && !(uid && token)) {
    const page = await fetchPage(`https://www.comeet.com/jobs/${hosted[1]}/${hosted[2]}`);
    const hostedToken = page.match(COMEET_TOKEN);
    if (hostedToken) found.push({ ats: 'comeet', slug: hosted[2], token: hostedToken[1] });
  }
  return found;
}

// Pages likely to link to the company's job board.
function careerPages(name, careersUrl) {
  const pages = new Set();
  if (careersUrl) pages.add(careersUrl);
  const domainLike = name.toLowerCase().match(/[a-z0-9-]+\.(com|io|ai|co\.il|co|net)\b/);
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
  const hosts = new Set();
  if (careersUrl) {
    try {
      const host = new URL(careersUrl).hostname;
      if (!/greenhouse|lever\.co|ashbyhq|comeet|smartrecruiters|workday|linkedin/.test(host)) hosts.add(host);
    } catch { /* not a URL */ }
  }
  if (domainLike) hosts.add(domainLike[0]);
  if (!hosts.size && base) for (const tld of ['com', 'io', 'ai', 'co.il']) hosts.add(`www.${base}.${tld}`);
  for (const host of hosts) for (const path of ['/careers', '/']) pages.add(`https://${host}${path}`);
  return [...pages].slice(0, 9);
}

// Links on a page that look like they lead to the jobs list.
function careerLinks(html, pageUrl) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    if (!/career|jobs|join-?us|work-with-us|positions|open-roles|vacanc/i.test(m[1])) continue;
    if (/\.(css|js|png|jpg|svg|ico|woff2?)(\?|$)/i.test(m[1]) || /linkedin|facebook|twitter|glassdoor/i.test(m[1])) continue;
    try { links.add(new URL(m[1], pageUrl).href); } catch { /* malformed link */ }
  }
  return [...links].slice(0, 4);
}

// Returns { company: {name, ats, slug}, israel, jobs } or null.
export async function discover(name, careersUrl, maxGuesses) {
  let best = null;
  const tryCompany = async (company) => {
    try {
      const result = await fetchCompany(company);
      if (result.israel > 0 && (!best || result.israel > best.israel)) best = { company, ...result };
    } catch { /* wrong guess */ }
  };

  // 1. The careers page usually names the board outright.
  const start = careerPages(name, careersUrl);
  const queue = start.map((url) => ({ url, follow: true }));
  const visited = new Set();
  while (queue.length && visited.size < 14) {
    const { url, follow } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const html = await fetchPage(url);
    for (const hit of await fingerprint(html)) await tryCompany({ name, ...hit });
    if (best) return best;
    if (follow) queue.push(...careerLinks(html, url).map((link) => ({ url: link, follow: false })));
  }
  // 2. Otherwise guess the board name from the company name.
  return findCompany(name, BROWSER_ATS, maxGuesses);
}

async function readCompanies() {
  try { return JSON.parse(await readFile(COMPANIES_FILE, 'utf8')); } catch { return []; }
}

export async function addCompany(company) {
  const companies = await readCompanies();
  if (companies.some((c) => c.ats === company.ats && c.slug === company.slug)) return false;
  companies.push(company);
  companies.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(COMPANIES_FILE, JSON.stringify(companies, null, 1) + '\n');
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  let names;
  const seedIndex = args.indexOf('--seed');
  if (seedIndex !== -1) names = JSON.parse(await readFile(args[seedIndex + 1], 'utf8'));
  else names = args.map((name) => ({ name }));

  const companies = await readCompanies();
  const known = new Set(companies.map((c) => c.name.toLowerCase()));
  const todo = names.filter((n) => !known.has(n.name.toLowerCase()));
  let found = 0;
  await pool(todo, 16, async ({ name, careers_url }) => {
    const hit = await discover(name, careers_url);
    if (!hit) { console.log(`-  ${name}`); return; }
    found++;
    console.log(`+  ${name}: ${hit.company.ats}/${hit.company.slug}  israel=${hit.israel} relevant=${hit.jobs.length}`);
    if (seedIndex !== -1 && !companies.some((c) => c.ats === hit.company.ats && c.slug === hit.company.slug)) companies.push(hit.company);
  });
  console.log(`\nfound ${found} of ${todo.length}`);
  if (seedIndex !== -1) {
    companies.sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(COMPANIES_FILE, JSON.stringify(companies, null, 1) + '\n');
    console.log(`companies.json now has ${companies.length} companies`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
