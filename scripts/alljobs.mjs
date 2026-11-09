// Jobs from AllJobs (alljobs.co.il), Israel's largest job site. Like Drushim
// it carries many companies and placement agencies found nowhere else. Its
// guest search pages are plain HTML and each result carries the posting's
// whole text, so the software category is read page by page and every posting
// is classified like any other.

import { classify, htmlToText } from '../docs/lib/classify.js';

const SEARCH = 'https://www.alljobs.co.il/SearchResultsGuest.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// 235 = software (with QA, hardware engineering, data and the like inside it).
const POSITIONS = [235];
const MAX_PAGES = 250;
const MINUTES = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPage(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'he,en;q=0.8' }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      if (attempt >= 2) throw err;
    }
    await sleep(4000 * (attempt + 1));
  }
}

const text = (html) => htmlToText(html || '').replace(/\s+/g, ' ').trim();

// "לפני 14 שעות", "לפני 3 ימים" or a date.
function posted(label) {
  const ago = label.match(/(\d+)\s*(דקות|דקה|שעות|שעה|ימים|יום)/);
  if (ago) {
    const unit = /דק/.test(ago[2]) ? 60000 : /שע/.test(ago[2]) ? 3600000 : 86400000;
    return new Date(Date.now() - Number(ago[1]) * unit).toISOString();
  }
  if (/אתמול/.test(label)) return new Date(Date.now() - 86400000).toISOString();
  const date = label.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return date ? new Date(`${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}T12:00:00+03:00`).toISOString() : null;
}

// The results on one page: { id, title, company, location, description, posted }.
export function parseResults(html) {
  const results = new Map();
  for (const card of html.split(/<div class="job-content-top-datestatus-container">/).slice(1)) {
    const id = card.match(/UploadSingle\.aspx\?JobID=(\d+)/)?.[1];
    const title = text(card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]);
    if (!id || !title || results.has(id)) continue;
    const company = text(card.match(/<div class="T14"><a [^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const where = text(card.match(/(?:מיקום המשרה|Location):\s*<\/b>([\s\S]*?)(?:<span|<\/div>)/)?.[1]);
    const cities = [...card.matchAll(/job-regions-content[\s\S]*?(?=<\/div><\/div><\/div><\/div>)/g)]
      .flatMap((m) => [...m[0].matchAll(/>([^<>]{2,40})<\/a>/g)].map((c) => c[1].trim()));
    const start = card.search(/job-content-top-type/);
    const end = card.search(/הגשת מועמדות/);
    const body = start < 0 ? '' : card.slice(card.indexOf('>', start) + 1, end > start ? end : undefined);
    results.set(id, {
      id,
      title,
      company,
      location: (/מספר מקומות/.test(where) ? cities[0] : where) || 'Israel',
      description: htmlToText(body.replace(/<script[\s\S]*?<\/script>/g, '')),
      posted: posted(text(card.match(/job-content-top-date">([\s\S]*?)<\/div>/)?.[1])),
    });
  }
  return [...results.values()];
}

// Returns { jobs, ok }. When AllJobs does not answer, ok is false and the
// previous AllJobs jobs are returned unchanged.
export async function collectAllJobs(previousJobs = []) {
  const found = new Map();
  const deadline = Date.now() + MINUTES * 60000;
  try {
    for (const position of POSITIONS) {
      for (let page = 1; page <= MAX_PAGES && Date.now() < deadline; page++) {
        const html = await getPage(`${SEARCH}?page=${page}&position=${position}&type=&freetxt=&city=&region=`);
        const results = parseResults(html);
        const before = found.size;
        for (const r of results) found.set(r.id, r);
        // Past the last page the site shows the last page again.
        if (!results.length || found.size === before) break;
        await sleep(700);
      }
    }
  } catch (err) {
    console.log(`alljobs: ${err.message}, kept the previous results`);
    return { jobs: previousJobs.filter((j) => j.id.startsWith('alljobs:')), ok: false };
  }
  const jobs = [];
  for (const r of found.values()) {
    const tags = classify({ title: r.title, location: 'Israel', description: r.description });
    if (!tags) continue;
    jobs.push({
      id: `alljobs:${r.id}`,
      // Postings AllJobs imports from abroad name no company.
      company: r.company || 'חברה לא צוינה',
      title: r.title,
      location: r.location,
      url: `https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=${r.id}`,
      posted: r.posted,
      source: 'AllJobs',
      ...tags,
    });
  }
  console.log(`alljobs: ${found.size} postings seen, ${jobs.length} kept`);
  return { jobs, ok: found.size > 0 };
}

// node scripts/alljobs.mjs [--out <file>]: with --out, the part for collect.mjs.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/alljobs.mjs')) {
  const at = process.argv.indexOf('--out');
  if (at > 0) {
    const { readJson, writePart } = await import('./parts.mjs');
    await writePart(process.argv[at + 1], await collectAllJobs((await readJson('docs/data/jobs.json', { jobs: [] })).jobs));
    process.exit(0);
  }
  const { jobs } = await collectAllJobs();
  for (const j of jobs) console.log(`${j.level.padEnd(7)} ${j.category.padEnd(9)} ${j.company} | ${j.title} | ${j.location}`);
}
