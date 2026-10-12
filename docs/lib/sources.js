// Job-board fetchers. Each returns raw postings in one shape:
//   { id, title, location, description, levelHint, url, posted }
// Greenhouse, Lever, Ashby and SmartRecruiters allow cross-origin requests, so
// the site can call them directly; Comeet, Workday and Amazon only work from Node.

import { classify, isIsrael, isSeniorTitle, isTechTitle } from './classify.js';

export const BROWSER_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

const UA = 'Mozilla/5.0 (compatible; job-radar/1.0)';
const inBrowser = typeof window !== 'undefined';

async function getJson(url, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (!inBrowser) headers['User-Agent'] = UA;
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(options.timeout || 25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Run fn over items with at most `limit` in flight.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Worth downloading the full description for? (Boards that list postings
// without a body need one request per posting.)
const worthDetails = (title, location) => isIsrael(location) && isTechTitle(title) && !isSeniorTitle(title);

const iso = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(+t) ? t.toISOString() : null;
};

const fetchers = {
  async greenhouse({ slug }) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return (data.jobs || []).map((j) => ({
      id: String(j.id),
      title: j.title,
      location: [j.location?.name, ...(j.offices || []).flatMap((o) => [o.name, o.location])],
      description: j.content,
      url: j.absolute_url,
      posted: iso(j.first_published || j.updated_at),
    }));
  },

  async lever({ slug }) {
    const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => ({
      id: j.id,
      title: j.text,
      location: [j.categories?.location, ...(j.categories?.allLocations || []), j.country === 'IL' ? 'Israel' : ''],
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${l.content}`), j.additionalPlain].join('\n'),
      levelHint: j.categories?.commitment,
      url: j.hostedUrl,
      posted: iso(j.createdAt),
    }));
  },

  async ashby({ slug }) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (data.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
      id: j.id,
      title: j.title,
      location: [
        j.location, j.address?.postalAddress?.addressCountry, j.address?.postalAddress?.addressLocality,
        ...(j.secondaryLocations || []).flatMap((s) => [s.location, s.address?.addressCountry]),
      ],
      description: j.descriptionPlain || j.descriptionHtml,
      levelHint: j.employmentType === 'Intern' ? 'intern' : '',
      url: j.jobUrl,
      posted: iso(j.publishedAt),
    }));
  },

  async smartrecruiters({ slug }) {
    const base = `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
    const list = [];
    for (let offset = 0; ; offset += 100) {
      const page = await getJson(`${base}?country=il&limit=100&offset=${offset}`);
      list.push(...(page.content || []));
      if (list.length >= (page.totalFound || 0) || !(page.content || []).length) break;
    }
    const wanted = list.filter((j) => worthDetails(j.name, 'Israel'));
    return pool(wanted, 6, async (j) => {
      let description = '';
      try {
        const detail = await getJson(`${base}/${j.id}`);
        description = Object.values(detail.jobAd?.sections || {}).map((s) => s.text).join('\n');
      } catch { /* listing data alone still classifies as "unknown" */ }
      const seniority = (j.customField || []).find((f) => /seniority/i.test(f.fieldLabel))?.valueLabel || '';
      return {
        id: String(j.id),
        title: j.name,
        location: [j.location?.fullLocation, j.location?.city, 'Israel'],
        description,
        levelHint: `${j.experienceLevel?.id || ''} ${seniority}`,
        url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        posted: iso(j.releasedDate),
      };
    });
  },

  // slug is the Comeet company uid; token is the public key the company's own
  // careers page uses to list its positions.
  async comeet({ slug, token }) {
    const positions = await getJson(`https://www.comeet.co/careers-api/2.0/company/${slug}/positions?token=${token}&details=true`);
    return positions.map((p) => ({
      id: String(p.uid),
      title: p.name,
      location: [p.location?.name, p.location?.city, p.location?.country === 'IL' ? 'Israel' : p.location?.country],
      description: (p.details || []).map((d) => `${d.name}\n${d.value || ''}`).join('\n'),
      levelHint: `${p.experience_level || ''} ${p.employment_type || ''}`,
      url: p.url_comeet_hosted_page || p.url_active_page || p.url_detected_page,
      posted: iso(p.time_updated),
    }));
  },

  // slug is "<tenant>.<wdN>/<site>", as in <tenant>.<wdN>.myworkdayjobs.com/<site>
  async workday({ slug }) {
    const [host, site] = slug.split('/');
    const tenant = host.split('.')[0];
    const origin = `https://${host}.myworkdayjobs.com`;
    const api = `${origin}/wday/cxs/${tenant}/${site}`;
    const search = (body) => getJson(`${api}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const first = await search({ limit: 20, offset: 0, searchText: '', appliedFacets: {} });
    const facet = findIsraelFacet(first.facets || []);
    const query = facet ? { searchText: '', appliedFacets: { [facet.param]: [facet.id] } } : { searchText: 'Israel', appliedFacets: {} };
    const head = await search({ limit: 20, offset: 0, ...query });
    const offsets = [];
    for (let o = 20; o < Math.min(head.total || 0, 2000); o += 20) offsets.push(o);
    const pages = await pool(offsets, 4, (offset) => search({ limit: 20, offset, ...query }).catch(() => ({ jobPostings: [] })));
    const postings = [head, ...pages].flatMap((p) => p.jobPostings || []).filter((p) => p.title && p.externalPath);

    // With the country facet applied every result is in Israel already.
    const wanted = postings.filter((p) => (facet ? isTechTitle(p.title) && !isSeniorTitle(p.title) : worthDetails(p.title, `${p.locationsText} ${p.externalPath}`)));
    const jobs = await pool(wanted, 4, async (p) => {
      try {
        const info = (await getJson(`${api}${p.externalPath}`)).jobPostingInfo || {};
        return {
          id: info.jobReqId || p.bulletFields?.[0] || p.externalPath,
          title: info.title || p.title,
          location: [info.location, ...(info.additionalLocations || []), info.country?.descriptor],
          description: info.jobDescription,
          levelHint: info.timeType && /intern/i.test(info.timeType) ? 'intern' : '',
          url: info.externalUrl || `${origin}/${site}${p.externalPath}`,
          posted: iso(info.startDate),
        };
      } catch { return null; }
    });
    return jobs.filter(Boolean);
  },

  async amazon() {
    const jobs = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await getJson(`https://www.amazon.jobs/en/search.json?normalized_country_code%5B%5D=ISR&result_limit=100&offset=${offset}`);
      jobs.push(...(page.jobs || []));
      if (jobs.length >= (page.hits || 0) || !(page.jobs || []).length) break;
    }
    return jobs.map((j) => ({
      id: String(j.id_icims || j.id),
      title: j.title,
      location: [j.city ? `${j.city}, Israel` : '', 'Israel'],
      // Preferred qualifications are left out: they are not requirements.
      description: `${j.description}\n${j.basic_qualifications}`,
      levelHint: j.is_intern ? 'intern' : '',
      url: `https://www.amazon.jobs${j.job_path}`,
      posted: iso(j.posted_date),
    }));
  },
};

function findIsraelFacet(facets, param) {
  for (const f of facets) {
    const p = f.facetParameter || param;
    if (f.descriptor === 'Israel' && f.id && p) return { param: p, id: f.id };
    const found = findIsraelFacet(f.values || [], p);
    if (found) return found;
  }
  return null;
}

// All postings of one company that are in Israel, with the relevant ones tagged.
// Returns { israel: <count of Israeli postings>, jobs: [relevant, normalized] }.
export async function fetchCompany(company) {
  const fetcher = fetchers[company.ats];
  if (!fetcher) throw new Error(`unknown ats "${company.ats}"`);
  const raw = await fetcher(company);
  const jobs = [];
  let israel = 0;
  for (const r of raw) {
    if (!r || !isIsrael(r.location)) continue;
    israel++;
    const tags = classify(r);
    if (!tags || !r.url) continue;
    jobs.push({
      id: `${company.ats}:${company.slug || company.name}:${r.id}`,
      company: company.name,
      title: String(r.title).trim(),
      location: displayLocation(r.location),
      url: r.url,
      posted: r.posted,
      ...tags,
    });
  }
  return { israel, jobs };
}

function displayLocation(location) {
  const parts = (Array.isArray(location) ? location : [location]).filter(Boolean).map(String);
  return (parts.find((p) => isIsrael(p) && p.length > 2 && !/^israel$/i.test(p)) || 'Israel').slice(0, 60);
}

// Likely board names for a company: "Check Point Software" -> checkpoint,
// check-point, checkpointsoftware, ...
export function slugCandidates(name) {
  const clean = name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9.\s-]/g, ' ').trim();
  const words = clean.replace(/\./g, ' ').split(/[\s-]+/).filter(Boolean);
  const core = words.filter((w) => !/^(ltd|inc|corp|co|company|technologies|technology|tech|systems|software|labs|group|israel|il|com|io|ai)$/.test(w));
  const out = new Set();
  const add = (list) => {
    if (!list.length) return;
    out.add(list.join(''));
    if (list.length > 1) out.add(list.join('-'));
  };
  add(words);
  add(core);
  if (core.length) for (const suffix of ['io', 'hq', 'ai', 'inc', 'security', 'labs', 'tech', 'technologies']) out.add(core.join('') + suffix);
  if (/\.(com|io|ai)\b/.test(clean)) out.add(clean.replace(/[^a-z0-9]/g, ''));
  return [...out].filter((s) => s.length >= 2).slice(0, 12);
}

// Looks for the company's board on the given job boards by guessing its name.
// A guess only counts if the board has postings in Israel, which filters out
// unrelated companies that happen to share the name.
export async function findCompany(name, atsList = BROWSER_ATS, maxGuesses = 12) {
  const attempts = slugCandidates(name).slice(0, maxGuesses).flatMap((slug) => atsList.map((ats) => ({ name, ats, slug })));
  let best = null;
  await pool(attempts, 8, async (company) => {
    try {
      const result = await fetchCompany(company);
      if (result.israel > 0 && (!best || result.israel > best.israel)) best = { company, ...result };
    } catch { /* no such board */ }
  });
  return best;
}
