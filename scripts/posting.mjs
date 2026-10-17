// Prints the full text of one job posting, for the CV tailoring workflow in
// the private state repo.
//   node scripts/posting.mjs <job id> <job url> <job title>
// jobs.json keeps no descriptions, so the posting is fetched again: from the
// job board's API when the id says which board it came from, otherwise from
// the job's page. A page only counts if it is about that job, so a closed
// posting that redirects to a list of openings is an error, not a posting.

import { readFile } from 'node:fs/promises';
import { fetchers } from '../docs/lib/sources.js';
import { htmlToText } from '../docs/lib/classify.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MIN_LENGTH = 300;

async function get(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'User-Agent': UA, ...(options.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
}

const pageText = (html) => htmlToText(String(html)
  .replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' '));

async function linkedin(id) {
  const html = await (await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`)).text();
  const body = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1];
  return body ? htmlToText(body) : '';
}

// <origin>/<site>/job/<location>/<title>_<req> -> <origin>/wday/cxs/<tenant>/<site>/job/...
async function workday(url) {
  const u = new URL(url);
  const [site, ...rest] = u.pathname.split('/').filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
  const tenant = u.hostname.split('.')[0];
  const data = await (await get(`${u.origin}/wday/cxs/${tenant}/${site}/${rest.join('/')}`, { headers: { Accept: 'application/json' } })).json();
  return htmlToText(data.jobPostingInfo?.jobDescription || '');
}

// Boards whose API lists every posting of the company with its description.
async function fromBoard(ats, slug, rawId) {
  const companies = JSON.parse(await readFile(new URL('../data/companies.json', import.meta.url), 'utf8'));
  const company = companies.find((c) => c.ats === ats && String(c.slug || c.name) === slug) || { name: slug, ats, slug };
  const postings = await fetchers[ats](company);
  const posting = postings.find((p) => p && String(p.id) === rawId);
  return posting ? htmlToText(posting.description || '') : '';
}

// Most of the title's words appear in the text, and the text is not a list of openings.
function aboutJob(text, title) {
  const words = String(title || '').toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((w) => w.length > 2);
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w)).length >= Math.ceil(words.length * 0.7) && !/\bopen (roles|positions)\b/i.test(text.slice(0, 400));
}

export async function postingText(id, url, title) {
  const [ats, ...parts] = String(id).split(':');
  const attempts = [];
  if (ats === 'linkedin') attempts.push(() => linkedin(parts[0]));
  else if (ats === 'workday') attempts.push(() => workday(url));
  else if (fetchers[ats] && parts.length >= 2) attempts.push(() => fromBoard(ats, parts.slice(0, -1).join(':'), parts.at(-1)));
  attempts.push(async () => {
    const text = pageText(await (await get(url)).text());
    if (!aboutJob(text, title)) throw new Error('the job page no longer shows this posting (it may be closed)');
    return text;
  });

  let lastError;
  for (const attempt of attempts) {
    try {
      const text = (await attempt()).trim();
      if (text.length >= MIN_LENGTH) return text;
      lastError = new Error('the posting text came back empty');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

if (process.argv[1]?.endsWith('posting.mjs')) {
  const [id, url, title] = process.argv.slice(2);
  try {
    process.stdout.write(`${await postingText(id, url, title)}\n`);
  } catch (err) {
    console.error(`Could not read the job posting: ${err.message}`);
    process.exit(1);
  }
}
