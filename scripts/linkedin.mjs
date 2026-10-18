// Jobs from LinkedIn's public (logged-out) job search. This is what covers small
// companies that have no job board of their own. LinkedIn throttles this
// endpoint, so requests are slow and sequential, and every posting's details
// are fetched only once: kept jobs are reused from the previous run and
// rejected ones are remembered in data/linkedin-cache.json.

import { readFile } from 'node:fs/promises';
import { categorize, classify, isSeniorTitle, isTechTitle, htmlToText } from '../docs/lib/classify.js';

const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// f_E: 1 = internship, 2 = entry level. LinkedIn's own level tag is unreliable,
// so the second group searches junior words across all levels.
const QUERIES = [
  ...['software engineer', 'software developer', 'backend', 'frontend', 'full stack', 'data', 'QA automation',
    'devops', 'embedded', 'algorithm', 'machine learning', 'AI', 'cyber security', 'verification', 'R&D',
  ].map((keywords) => ({ keywords, f_E: '1,2' })),
  ...['junior developer', 'junior engineer', 'student software', 'student developer', 'student engineer', 'graduate engineer',
    'intern software', 'entry level developer',
  ].map((keywords) => ({ keywords })),
  // Embedded and low-level roles are rarely tagged entry level even when they
  // are, so these go over every level, newest first.
  ...['embedded software', 'embedded engineer', 'firmware', 'RTOS', 'real time software', 'linux kernel', 'device driver',
    'BSP', 'low level', 'C++ developer', 'C developer', 'DSP', 'FPGA', 'chip design', 'system software', 'robotics software',
    'IoT', 'communication software',
  ].map((keywords) => ({ keywords, sortBy: 'DD' })),
  // The week's newest postings of the widest searches, whatever level they are tagged.
  ...['software engineer', 'software developer', 'backend developer', 'full stack developer', 'python developer',
    'java developer', 'data engineer', 'QA engineer', 'automation engineer', 'devops engineer', 'algorithm engineer',
    'machine learning engineer', 'security researcher', 'verification engineer', 'מפתח תוכנה', 'מהנדס תוכנה',
  ].map((keywords) => ({ keywords, sortBy: 'DD', f_TPR: 'r604800' })),
];
// LinkedIn serves up to 1000 results (100 pages) per search.
const MAX_PAGES = 100;
const PAGE_SIZE = 10;
const CACHE_DAYS = 45;
// Reading a posting takes a few seconds once LinkedIn starts throttling, so a
// run reads a bounded number of new ones and the next run continues.
const MAX_NEW_PER_RUN = Number(process.env.LINKEDIN_MAX_NEW) || 500;

// The searches stop after this long, so a throttled run still finishes.
const SEARCH_MINUTES = 40;
// ...and reading new postings stops this long after the start.
const TOTAL_MINUTES = 70;

// The workflow runs several copies at once, each on its own machine (and so
// its own address, which LinkedIn throttles separately). SHARD=i/n makes this
// copy do every n-th search.
const [SHARD, SHARDS] = (process.env.SHARD || '0/1').split('/').map(Number);
const mine = (list) => list.filter((_, i) => i % SHARDS === SHARD);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let blocked = false;

async function get(url) {
  for (let attempt = 0; attempt < 4 && !blocked; attempt++) {
    await sleep(350 + Math.random() * 250);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.text();
      if (res.status === 404 || res.status === 400) return '';
      if (res.status !== 429 && res.status < 500) { blocked = true; break; }
    } catch { /* retry */ }
    await sleep(4000 * (attempt + 1));
  }
  return null;
}

const clean = (s) => htmlToText(s || '').replace(/\s+/g, ' ').trim();

function parseCards(html) {
  return html.split(/<li[ >]/).slice(1).map((card) => {
    const id = card.match(/urn:li:jobPosting:(\d+)/)?.[1];
    if (!id) return null;
    return {
      id,
      title: clean(card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1]),
      company: clean(card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1]),
      location: clean(card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1]),
      posted: card.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] || null,
    };
  }).filter((c) => c && c.title && c.company);
}

async function search(query) {
  const cards = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ location: 'Israel', f_TPR: 'r2592000', ...query, start: String(page * PAGE_SIZE) });
    const html = await get(`${SEARCH}?${params}`);
    if (html == null) return { cards, failed: true };
    const found = parseCards(html);
    cards.push(...found);
    if (found.length < PAGE_SIZE) break;
  }
  return { cards, failed: false };
}

// Everything posted by the Israeli tech companies listed in
// data/linkedin-companies.json (LinkedIn company ids, from the Israeli Tech Map),
// a group of companies per search. This reaches small companies whose postings
// the keyword searches above never get to.
async function companyQueries() {
  let ids;
  try { ids = JSON.parse(await readFile(new URL('../data/linkedin-companies.json', import.meta.url), 'utf8')); } catch { return []; }
  const groups = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
  const queries = mine([...groups(ids.big, 5), ...groups(ids.rest, 30)].map((group) => ({ f_C: group.join(','), sortBy: 'DD' })));
  // A run that is out of time stops part-way, so each run starts somewhere else.
  const start = Math.floor(Math.random() * queries.length);
  return [...queries.slice(start), ...queries.slice(0, start)];
}

// previousJobs: last run's jobs; cache: { [linkedin id]: ISO date it was rejected }.
// Returns { jobs, cache, ok }. When LinkedIn refuses to answer, ok is false and
// the previous LinkedIn jobs are returned unchanged.
export async function collectLinkedIn(previousJobs, cache = {}) {
  const previous = new Map(previousJobs.filter((j) => j.id.startsWith('linkedin:')).map((j) => [j.id, j]));
  const cards = new Map();
  let failedQueries = 0;
  const started = Date.now();
  const deadline = started + SEARCH_MINUTES * 60000;
  const queries = [...mine(QUERIES), ...await companyQueries()];
  let searched = 0;
  for (const query of queries) {
    // Out of time: whatever was not searched keeps its previous jobs.
    if (Date.now() > deadline) { failedQueries++; break; }
    const result = await search(query);
    searched++;
    if (result.failed) failedQueries++;
    for (const card of result.cards) cards.set(card.id, card);
    if (blocked) break;
  }
  if (!cards.size) return { jobs: [...previous.values()], cache, ok: false };

  const now = new Date().toISOString();
  const jobs = [];
  let fetched = 0;
  // With a bounded number of reads per run, embedded postings go first.
  const embeddedFirst = (card) => (categorize(card.title) === 'Embedded' ? 0 : 1);
  for (const card of [...cards.values()].sort((a, b) => embeddedFirst(a) - embeddedFirst(b))) {
    const id = `linkedin:${card.id}`;
    if (previous.has(id)) { jobs.push(previous.get(id)); continue; }
    if (cache[card.id] || !isTechTitle(card.title) || isSeniorTitle(card.title)) continue;

    const outOfTime = Date.now() > started + TOTAL_MINUTES * 60000;
    const html = blocked || outOfTime || fetched >= MAX_NEW_PER_RUN ? null : await get(`${DETAIL}/${card.id}`);
    if (html == null) continue; // try again next run
    fetched++;
    const description = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
    const seniority = html.match(/Seniority level[\s\S]*?description__job-criteria-text[^>]*>\s*([^<]*?)\s*</)?.[1] || '';
    const tags = classify({
      title: card.title,
      location: 'Israel',
      description,
      levelHint: /intern/i.test(seniority) ? 'intern' : /director|executive/i.test(seniority) ? seniority : '',
    });
    if (!tags) { cache[card.id] = now; continue; }
    jobs.push({
      id,
      company: card.company,
      title: card.title,
      location: card.location || 'Israel',
      url: `https://www.linkedin.com/jobs/view/${card.id}`,
      posted: card.posted ? new Date(card.posted).toISOString() : null,
      source: 'LinkedIn',
      ...tags,
    });
  }
  // A query that failed half-way may hide jobs that are still open.
  if (failedQueries) for (const [id, job] of previous) if (!jobs.some((j) => j.id === id)) jobs.push(job);

  const cutoff = Date.now() - CACHE_DAYS * 86400000;
  for (const [id, date] of Object.entries(cache)) if (new Date(date) < cutoff) delete cache[id];
  console.log(`linkedin${SHARDS > 1 ? ` ${SHARD + 1}/${SHARDS}` : ''}: ${searched} of ${queries.length} searches, ${cards.size} postings seen, ${fetched} new ones read, ${jobs.length} kept${failedQueries ? `, ${failedQueries} queries failed` : ''}`);
  return { jobs, cache, ok: true };
}

// node scripts/linkedin.mjs [--out <file>]: with --out, one shard's part for collect.mjs.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/linkedin.mjs')) {
  const at = process.argv.indexOf('--out');
  if (at > 0) {
    const { readJson, writePart } = await import('./parts.mjs');
    const previous = await readJson('docs/data/jobs.json', { jobs: [] });
    await writePart(process.argv[at + 1], await collectLinkedIn(previous.jobs, await readJson('data/linkedin-cache.json', {})));
  } else {
    const { jobs } = await collectLinkedIn([], {});
    for (const j of jobs) console.log(`${j.level.padEnd(7)} ${j.category.padEnd(9)} ${j.company} | ${j.title} | ${j.location}`);
  }
}
