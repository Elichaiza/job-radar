// Jobs from Drushim (drushim.co.il), the Israeli job site. It carries many
// small and mid-sized companies and placement agencies that are on no board
// the collector knows and rarely on LinkedIn. Its public search API filters by
// category and by experience, so only tech jobs asking for at most 1-2 years
// are read, and each is classified like any other posting.

import { classify, htmlToText } from '../docs/lib/classify.js';

const API = 'https://webapi.drushim.co.il/api/jobs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Software, QA, hardware, information security, general high-tech.
const CATEGORIES = [6, 24, 4, 30, 5];
// Drushim's experience codes: 1 = none, 2 = 1-2 years.
const EXPERIENCE = '1-2';
const MAX_PAGES = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      if (attempt >= 2) throw err;
    }
    await sleep(3000 * (attempt + 1));
  }
}

const city = (job) => job.JobContent.Addresses?.find((a) => a.CityEnglish?.trim())?.CityEnglish.trim();

function toJob(job) {
  const content = job.JobContent;
  const tags = classify({
    title: content.Name,
    location: 'Israel',
    description: `${content.Description || ''}\n${content.Requirements || ''}`,
  });
  if (!tags) return null;
  // The posting gave no years in its text; Drushim's own field still says how many.
  if (tags.level === 'unknown' && content.Experience?.Code === 1) Object.assign(tags, { level: 'entry', years: 0 });
  if (tags.level === 'unknown' && content.Experience?.Code === 2) Object.assign(tags, { level: 'y2', years: 1, evidence: 'Drushim: 1-2 שנים ניסיון' });
  return {
    id: `drushim:${job.Code}`,
    company: job.Company.CompanyDisplayName.trim(),
    title: content.Name.trim(),
    location: city(job) || 'Israel',
    url: `https://www.drushim.co.il${job.JobInfo.Link}`,
    posted: job.JobInfo.Date ? new Date(`${job.JobInfo.Date}+03:00`).toISOString() : null,
    source: 'Drushim',
    ...tags,
  };
}

// Returns { jobs, ok }. When Drushim does not answer, ok is false and the
// previous Drushim jobs are returned unchanged.
export async function collectDrushim(previousJobs = []) {
  const found = new Map();
  try {
    for (const category of CATEGORIES) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await getJson(`${API}/search?catdir=${category}&experience=${EXPERIENCE}&page=${page}`);
        const results = data.ResultList || [];
        // Past the category's own results the search pads with related ones.
        for (const job of results) {
          if (job.JobContent?.Categories?.some((c) => c.Code === category) && !job.JobInfo?.IsExpired) found.set(job.Code, job);
        }
        if (!results.length || !data.NextPageNumber || data.NextPageNumber <= page) break;
        await sleep(300);
      }
    }
  } catch (err) {
    console.log(`drushim: ${err.message}, kept the previous results`);
    return { jobs: previousJobs.filter((j) => j.id.startsWith('drushim:')), ok: false };
  }
  const jobs = [...found.values()].map(toJob).filter(Boolean);
  console.log(`drushim: ${found.size} postings seen, ${jobs.length} kept`);
  return { jobs, ok: true };
}

// The full text of one posting, for the CV tailoring workflow.
export async function drushimPosting(url) {
  const [, code, hash] = String(url).match(/\/job\/(\d+)\/(\w+)/) || [];
  if (!code) return '';
  const data = await getJson(`${API}/job?jobCode=${code}&jobHash=${hash}`);
  const content = data.JobContent || data.Job?.JobContent || data;
  return htmlToText(`${content.Name || ''}\n${content.Description || ''}\n${content.Requirements || ''}`);
}

// node scripts/drushim.mjs [--out <file>]: with --out, the part for collect.mjs.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/drushim.mjs')) {
  const at = process.argv.indexOf('--out');
  if (at > 0) {
    const { readJson, writePart } = await import('./parts.mjs');
    await writePart(process.argv[at + 1], await collectDrushim((await readJson('docs/data/jobs.json', { jobs: [] })).jobs));
    process.exit(0);
  }
  const { jobs } = await collectDrushim();
  for (const j of jobs) console.log(`${j.level.padEnd(7)} ${j.category.padEnd(9)} ${j.company} | ${j.title} | ${j.location}`);
}
