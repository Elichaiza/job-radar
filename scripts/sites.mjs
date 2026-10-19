// Companies that reach the list only through a LinkedIn or Drushim posting are
// on no list the collector reads by itself, so their own careers pages were
// never looked at. Each such company's website is looked up on its LinkedIn
// company page and added to data/career-pages.json: from the next run on its
// careers page is read like every other company's, and a job board it leads to
// is added. A company with only Drushim postings is looked for on the job
// boards by its name instead.

import { findCompany } from '../docs/lib/sources.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Lookups per run; the rest wait for the next run.
const MAX_PER_RUN = 60;
// A company whose site was not found is looked for again after this long.
const RETRY_DAYS = 30;
// Not companies: placement agencies post under these when the employer is hidden.
const HIDDEN = /חסוי|confidential|confidentiel|^-|jobgether|snatch ?up|^jobist$|stealth/i;
// A website that is just another profile.
const NOT_A_SITE = /linkedin\.com|facebook\.com|instagram\.com|twitter\.com|^x\.com|youtube\.com|linktr\.ee|linktree\.com|wa\.me|harmonic\.ai/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const normName = (s) => String(s).toLowerCase().replace(/\b(ltd|inc|corp|llc|group|israel)\b/g, '').replace(/[^a-z0-9א-ת]/g, '');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function get(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(800 + Math.random() * 600);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.text();
      if (res.status === 404) return '';
    } catch { /* retry */ }
    await sleep(4000 * (attempt + 1));
  }
  return null;
}

// The company's website, from one of its LinkedIn postings.
async function websiteFromLinkedIn(jobId) {
  const posting = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`);
  const slug = posting?.match(/linkedin\.com\/company\/([\w%.-]+)/)?.[1];
  if (!slug) return null;
  const page = await get(`https://www.linkedin.com/company/${slug}`);
  const link = page?.match(/data-tracking-control-name="about_website"[^>]*href="([^"]+)"/)?.[1]
    || page?.match(/href="([^"]+)"[^>]*data-tracking-control-name="about_website"/)?.[1];
  if (!link) return null;
  let url = link.replace(/&amp;/g, '&');
  try { url = new URL(url).searchParams.get('url') || url; } catch { return null; }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return host(url) && !NOT_A_SITE.test(host(url)) ? url : null;
}

// jobs: this run's jobs. careerPages and companies are changed in place.
// cache: { [normName]: ISO date of a lookup that found nothing }.
// Returns the board jobs of companies found on a job board right away.
export async function findSites(jobs, careerPages, companies, cache) {
  const now = new Date().toISOString();
  const knownNames = new Set([...careerPages, ...companies].map((c) => normName(c.name)));
  const knownHosts = new Set(careerPages.map((c) => host(c.url)));
  const cutoff = Date.now() - RETRY_DAYS * 86400000;
  for (const [name, date] of Object.entries(cache)) if (new Date(date) < cutoff) delete cache[name];

  const candidates = new Map();
  for (const job of jobs) {
    if (!/^(linkedin|drushim):/.test(job.id) || HIDDEN.test(job.company.trim())) continue;
    const key = normName(job.company);
    if (key.length < 2 || knownNames.has(key) || cache[key]) continue;
    const entry = candidates.get(key) || { name: job.company.trim(), linkedin: null };
    if (job.id.startsWith('linkedin:')) entry.linkedin ??= job.id.slice('linkedin:'.length);
    candidates.set(key, entry);
  }

  const found = [];
  let sites = 0;
  let boards = 0;
  for (const [key, { name, linkedin }] of [...candidates].slice(0, MAX_PER_RUN)) {
    const url = linkedin ? await websiteFromLinkedIn(linkedin) : null;
    if (url && !knownHosts.has(host(url))) {
      // A site outside .il may well list the company's openings abroad too.
      careerPages.push({ name, url, home: true, ...(/\.il$/i.test(host(url)) ? {} : { abroad: true }) });
      knownHosts.add(host(url));
      sites++;
      continue;
    }
    if (url) continue; // a site already read under another name
    // Hebrew names make no board name to guess.
    const hit = /[a-z]/i.test(name) ? await findCompany(name, undefined, 4).catch(() => null) : null;
    if (hit) {
      companies.push(hit.company);
      found.push(...hit.jobs);
      boards++;
      console.log(`board for ${name}: ${hit.company.ats}/${hit.company.slug}, ${hit.jobs.length} relevant jobs`);
    } else {
      cache[key] = now;
    }
  }
  console.log(`company sites: ${candidates.size} companies not on any list, ${Math.min(candidates.size, MAX_PER_RUN)} looked up, ${sites} sites and ${boards} job boards added`);
  return found;
}
