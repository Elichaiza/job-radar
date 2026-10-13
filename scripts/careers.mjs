// Jobs read straight from companies' own careers pages, for companies whose
// postings are not on a job board the collector knows. A careers page is plain
// HTML with a link per opening: links whose text reads like a tech job title
// are followed, and the page behind each one is classified like any posting.
// Pages that build their list with JavaScript yield nothing and are skipped.
//
// data/career-pages.json: [{ name, url, abroad? }], from the Israeli Tech Map.
// "abroad" marks multinationals, whose postings must mention Israel to count.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { classify, htmlToText, isIsrael, isSeniorTitle, isTechTitle } from '../docs/lib/classify.js';
import { pool } from '../docs/lib/sources.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CACHE_DAYS = 30;
const MAX_LINKS_PER_COMPANY = 25;
const MINUTES = 25;

async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,he;q=0.8' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
    const html = await res.text();
    return { url: res.url, html: html.length > 1500000 ? html.slice(0, 1500000) : html };
  } catch { return null; }
}

const stripCode = (html) => html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
// Navigation and footers carry text ("20 years of innovation") that is not about the job.
const stripChrome = (html) => stripCode(html).replace(/<(nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' ');
const oneLine = (html) => htmlToText(html).replace(/\s+/g, ' ').trim();

// Links on a careers page that look like openings: [{ title, url }].
export function jobLinks(html, pageUrl) {
  const found = new Map();
  const page = new URL(pageUrl);
  for (const m of stripCode(html).matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[1].replace(/&amp;/g, '&'), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || (url.origin + url.pathname === page.origin + page.pathname && !url.search)) continue;
    // A card often wraps the title together with the location and a button.
    const heading = m[2].match(/<(h[1-6]|strong|b)\b[^>]*>([\s\S]*?)<\/\1>/i);
    const title = oneLine(heading ? heading[2] : m[2]);
    if (title.length < 5 || title.length > 90 || !isTechTitle(title) || isSeniorTitle(title)) continue;
    // Product and blog pages use the same words; an opening names a role.
    if (!ROLE.test(title) || /\b(center|portal|docs|documentation|api|community|hub|tools?|program|platform)\b|למפתחים/i.test(title)) continue;
    url.hash = '';
    if (!found.has(url.href)) found.set(url.href, { title, url: url.href });
  }
  return [...found.values()].slice(0, MAX_LINKS_PER_COMPANY);
}

// The homepage's link to the careers page, if it has one on a site we can read.
function careersLink(html, pageUrl) {
  for (const m of stripCode(html).matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = oneLine(m[2]);
    if (text.length > 40 || !/\b(careers?|jobs|join us|join our team|open positions|we.re hiring|work with us)\b|קריירה|דרושים|משרות/i.test(`${text} ${m[1].slice(0, 80)}`)) continue;
    try {
      const url = new URL(m[1].replace(/&amp;/g, '&'), pageUrl);
      if (/^https?:$/.test(url.protocol) && !/linkedin\.com|facebook\.com|greenhouse\.io|lever\.co|ashbyhq\.com|comeet\.co|myworkdayjobs\.com/i.test(url.hostname)) return url.href;
    } catch { /* malformed link */ }
  }
  return null;
}

const ROLE =/\b(engineer|developer|programmer|researcher|scientist|analyst|tester|student|intern|qa|devops|sre|administrator|specialist|team member)\b|מפתח|מהנדס|בודק|חוקר|אלגוריתמאי|סטודנט|מתכנת/i;
// What the page of a real opening talks about.
const POSTING = /\b(requirements?|qualifications?|responsibilit\w+|what you.ll do|who you are|about the (role|position|job)|apply now|apply for|submit your (cv|resume)|send (us )?your (cv|resume))\b|דרישות|תיאור התפקיד|תיאור המשרה|קורות חיים/i;

const idOf = (url) => `site:${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;

// previousJobs: last run's jobs; cache: { [job url]: ISO date it was rejected }.
export async function collectCareerPages(previousJobs, cache = {}) {
  let companies;
  try { companies = JSON.parse(await readFile(new URL('../data/career-pages.json', import.meta.url), 'utf8')); } catch { return { jobs: [], cache }; }
  const previous = new Map(previousJobs.filter((j) => j.id.startsWith('site:')).map((j) => [j.id, j]));
  const now = new Date().toISOString();
  const deadline = Date.now() + MINUTES * 60000;
  const jobs = [];
  let pages = 0;
  let read = 0;

  // Companies with a known careers page are read every run; the long list of
  // homepages starts somewhere else each run and goes as far as time allows.
  const known = companies.filter((c) => !c.home);
  const homes = companies.filter((c) => c.home);
  const start = Math.floor(Math.random() * (homes.length || 1));
  await pool([...known, ...homes.slice(start), ...homes.slice(0, start)], 10, async (company) => {
    const mine = () => [...previous.values()].filter((j) => j.company === company.name);
    // Out of time or the site is down: keep what this company had.
    if (Date.now() > deadline) { jobs.push(...mine()); return; }
    let page = await fetchPage(company.url);
    // Only the homepage is known: the careers page is whatever it links to as such.
    if (page && company.home) {
      const careers = careersLink(page.html, page.url);
      if (!careers) return;
      page = await fetchPage(careers);
    }
    if (!page) { jobs.push(...mine()); return; }
    pages++;
    for (const link of jobLinks(page.html, page.url)) {
      const id = idOf(link.url);
      if (previous.has(id)) { jobs.push(previous.get(id)); continue; }
      if (cache[link.url]) continue;
      const detail = await fetchPage(link.url);
      if (!detail) continue;
      read++;
      const text = htmlToText(stripChrome(detail.html));
      // The link has to lead to a page about that job, not to a general page.
      const words = link.title.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const aboutJob = text.length > 300 && words.filter((w) => text.toLowerCase().includes(w)).length >= Math.ceil(words.length * 0.7);
      const inIsrael = !company.abroad || isIsrael(text.slice(0, 6000).split(/[\n,.|]/));
      const tags = aboutJob && POSTING.test(text) && inIsrael ? classify({ title: link.title, location: 'Israel', description: text }) : null;
      if (!tags) { cache[link.url] = now; continue; }
      jobs.push({ id, company: company.name, title: link.title, location: 'Israel', url: link.url, posted: null, source: 'אתר החברה', ...tags });
    }
  });

  const cutoff = Date.now() - CACHE_DAYS * 86400000;
  for (const [url, date] of Object.entries(cache)) if (new Date(date) < cutoff) delete cache[url];
  console.log(`career pages: ${pages} of ${companies.length} read, ${read} new postings read, ${jobs.length} kept`);
  return { jobs: [...new Map(jobs.map((j) => [j.id, j])).values()], cache };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/careers.mjs')) {
  const { jobs } = await collectCareerPages([], {});
  for (const j of jobs) console.log(`${j.level.padEnd(7)} ${j.category.padEnd(9)} ${j.company} | ${j.title} | ${j.url}`);
}
