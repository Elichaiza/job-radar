import { CATEGORIES, LEVELS } from './lib/classify.js';
import { findCompany } from './lib/sources.js';
import * as accounts from './accounts.js';

// With accounts on, every user signs in and their marks live in their account.
// Without them (docs/config.js not filled in) the marks of the single user live
// in the private "<repo>-state" repo, reached with a GitHub token.
const ACCOUNTS = accounts.enabled;

// On GitHub Pages the address is <owner>.github.io/<repo>/, which tells us
// where the data lives.
const pagesHost = location.hostname.match(/^([\w-]+)\.github\.io$/);
const OWNER = pagesHost ? pagesHost[1] : 'Elichaiza';
const SITE_REPO = (pagesHost && location.pathname.split('/')[1]) || 'job-radar';
const STATE_REPO = `${SITE_REPO}-state`;
const API = 'https://api.github.com';

const LEVEL_LABELS = { intern: 'סטודנט / Intern', entry: 'ללא ניסיון', y1: 'שנה', y2: 'שנתיים', unknown: 'לא צוין' };
const NEW_DAYS = 3;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`jr.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`jr.${key}`, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

let jobs = [];
let state = normalizeState(store.get('state'));
let token = store.get('token', '');
let user = null; // { uid, email } once signed in
// Are marks being saved somewhere other than this browser?
const synced = () => (ACCOUNTS ? Boolean(user) : Boolean(token));
const filters = store.get('filters', { categories: [], levels: [], search: '', onlyNew: false, showSeen: false, sort: 'new' });
let sideTab = 'applied';
let shown = 0;
let visible = [];
const PAGE = 60;

function normalizeState(s) {
  return { applied: s?.applied || {}, seen: s?.seen || {} };
}

// --- small DOM helper: text is always set as text, never as HTML -----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : '#');

function ago(isoDate) {
  if (!isoDate) return '';
  const days = Math.floor((Date.now() - new Date(isoDate)) / 86400000);
  if (days <= 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 30) return `לפני ${days} ימים`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'לפני חודש' : `לפני ${months} חודשים`;
}

const jobDate = (job) => job.posted || job.firstSeen;
const isNew = (job) => Date.now() - new Date(jobDate(job)) < NEW_DAYS * 86400000;

// --- GitHub storage ---------------------------------------------------------

async function github(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
  return res.json();
}

const encode = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function readFile(repo, path, fallback) {
  try {
    const file = await github(`/repos/${OWNER}/${repo}/contents/${path}?t=${Date.now()}`);
    return { data: JSON.parse(decode(file.content)), sha: file.sha };
  } catch (err) {
    if (err.status === 404) return { data: fallback, sha: undefined };
    throw err;
  }
}

// Read-modify-write, retried when someone else (another device, the collector)
// wrote the file in between.
async function updateFile(repo, path, fallback, change, message) {
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await readFile(repo, path, fallback);
    const next = change(data);
    try {
      await github(`/repos/${OWNER}/${repo}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({ message, sha, content: encode(JSON.stringify(next, null, 1) + '\n') }),
      });
      return next;
    } catch (err) {
      if (attempt >= 3 || (err.status !== 409 && err.status !== 422)) throw err;
    }
  }
}

// Marks made since the last successful save; replayed on top of whatever is
// stored remotely so two devices never overwrite each other.
let pendingOps = store.get('pendingOps', []);
let saveTimer;
let saving = false;

function applyOp(target, op) {
  if (op.value == null) delete target[op.kind][op.id];
  else target[op.kind][op.id] = op.value;
}

function mark(kind, id, value) {
  const op = { kind, id, value };
  applyOp(state, op);
  store.set('state', state);
  if (ACCOUNTS || token) {
    pendingOps.push(op);
    store.set('pendingOps', pendingOps);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushState, 900);
  }
  render();
}

async function pushState() {
  if (saving || !pendingOps.length || !synced()) return;
  saving = true;
  const ops = pendingOps.slice();
  try {
    if (ACCOUNTS) await accounts.saveOps(ops);
    else await updateFile(STATE_REPO, 'state.json', {}, (remote) => {
      const merged = normalizeState(remote);
      ops.forEach((op) => applyOp(merged, op));
      return merged;
    }, 'update marks');
    pendingOps = pendingOps.slice(ops.length);
    store.set('pendingOps', pendingOps);
    setSyncNote('');
  } catch (err) {
    setSyncNote(!ACCOUNTS && (err.status === 401 || err.status === 403 || err.status === 404)
      ? 'הסימונים נשמרו רק בדפדפן: הטוקן לא תקף או חסרה לו הרשאה.'
      : 'הסימונים נשמרו בדפדפן ויסונכרנו כשהחיבור יחזור.');
  } finally {
    saving = false;
    if (pendingOps.length) saveTimer = setTimeout(pushState, 5000);
  }
}

async function pullState() {
  if (!synced()) return;
  try {
    const data = ACCOUNTS ? await accounts.loadState() : (await readFile(STATE_REPO, 'state.json', {})).data;
    const merged = normalizeState(data);
    pendingOps.forEach((op) => applyOp(merged, op));
    state = merged;
    store.set('state', state);
    setSyncNote('');
    render();
    if (pendingOps.length) pushState();
  } catch (err) {
    setSyncNote(ACCOUNTS ? 'לא הצלחתי לטעון את הסימונים מהחשבון. מוצגים הסימונים השמורים בדפדפן.'
      : err.status === 401 || err.status === 403 || err.status === 404
        ? 'החיבור ל-GitHub נכשל: הטוקן לא תקף או חסרה לו הרשאה. הסימונים נשמרים בדפדפן בלבד.'
        : 'לא הצלחתי לטעון את הסימונים מ-GitHub. מוצגים הסימונים השמורים בדפדפן.');
  }
}

let syncNote = '';
function setSyncNote(text) {
  syncNote = text;
  renderStatus();
}

// --- loading jobs -----------------------------------------------------------

let generatedAt = null;
let companyCount = 0;

async function loadJobs() {
  try {
    const res = await fetch(`data/jobs.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    generatedAt = data.generatedAt;
    companyCount = data.companies || 0;
    const ids = new Set(data.jobs.map((j) => j.id));
    // Jobs found by a company search stay until the collector publishes them.
    const extra = store.get('extraJobs', []).filter((j) => !ids.has(j.id) && Date.now() - new Date(j.firstSeen) < 2 * 86400000);
    store.set('extraJobs', extra);
    jobs = [...extra, ...data.jobs];
  } catch {
    $('status').textContent = 'לא הצלחתי לטעון את רשימת המשרות. נסה לרענן את הדף.';
    return;
  }
  render();
}

// --- filtering and rendering ------------------------------------------------

function matches(job, { ignore } = {}) {
  if (state.applied[job.id]) return false;
  if (state.seen[job.id] && !filters.showSeen) return false;
  if (filters.onlyNew && !isNew(job)) return false;
  if (ignore !== 'category' && filters.categories.length && !filters.categories.includes(job.category)) return false;
  if (ignore !== 'level' && filters.levels.length && !filters.levels.includes(job.level)) return false;
  if (filters.search) {
    const haystack = `${job.title} ${job.company} ${job.location} ${job.category}`.toLowerCase();
    if (!filters.search.toLowerCase().split(/\s+/).every((word) => haystack.includes(word))) return false;
  }
  return true;
}

function renderChips(container, values, labels, selected, countOf) {
  container.replaceChildren(...values.map((value) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(selected.includes(value)),
    onclick: () => {
      const i = selected.indexOf(value);
      if (i === -1) selected.push(value); else selected.splice(i, 1);
      render();
    },
  }, labels?.[value] || value, el('span', { class: 'n', text: String(countOf(value)) }))));
}

function jobCard(job) {
  const seen = Boolean(state.seen[job.id]);
  return el('article', { class: `job${seen ? ' seen' : ''}` },
    el('div', {},
      el('a', { class: 'job-title', href: safeUrl(job.url), target: '_blank', rel: 'noopener noreferrer', text: job.title }),
      el('div', { class: 'job-meta', text: [job.company, job.location, ago(jobDate(job)), job.source && `דרך ${job.source}`].filter(Boolean).join(' · ') }),
      el('div', { class: 'tags' },
        isNew(job) && el('span', { class: 'tag new', text: 'חדש' }),
        el('span', { class: 'tag', text: job.category }),
        el('span', { class: `tag level ${job.level}`, text: LEVEL_LABELS[job.level] })),
      job.evidence && el('div', { class: 'job-evidence', text: `“${job.evidence}”` })),
    el('div', { class: 'job-actions' },
      el('a', { class: 'btn primary', href: safeUrl(job.url), target: '_blank', rel: 'noopener noreferrer', text: 'Apply' }),
      el('button', {
        class: 'btn', type: 'button', text: 'הגשתי',
        onclick: () => mark('applied', job.id, { title: job.title, company: job.company, url: job.url, at: new Date().toISOString() }),
      }),
      el('button', {
        class: 'btn', type: 'button', text: seen ? 'החזר' : 'ראיתי, הסתר',
        onclick: () => mark('seen', job.id, seen ? null : { title: job.title, company: job.company, url: job.url, at: new Date().toISOString() }),
      })));
}

function renderMore() {
  const next = visible.slice(shown, shown + PAGE);
  $('jobs').append(...next.map(jobCard));
  shown += next.length;
}

function renderStatus() {
  if (!generatedAt) return;
  const minutes = Math.round((Date.now() - new Date(generatedAt)) / 60000);
  const when = minutes < 60 ? `לפני ${Math.max(minutes, 1)} דק׳` : minutes < 2880 ? `לפני ${Math.round(minutes / 60)} שעות` : ago(generatedAt);
  const sync = ACCOUNTS ? (user ? `מחובר כ-${user.email}` : 'לא מחובר')
    : token ? 'מסונכרן עם GitHub' : 'הסימונים נשמרים בדפדפן הזה בלבד';
  $('status').textContent = syncNote || `${jobs.length} משרות מ-${companyCount} חברות · עודכן ${when} · ${sync}`;
}

function renderSide() {
  const entries = Object.entries(state[sideTab]).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  $('applied-count').textContent = $('applied-count-top').textContent = Object.keys(state.applied).length;
  $('seen-count').textContent = Object.keys(state.seen).length;
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === sideTab));
  if (!entries.length) {
    $('side-list').replaceChildren(el('li', { class: 'muted', text: sideTab === 'applied' ? 'עדיין לא סימנת משרות שהגשת אליהן.' : 'אין משרות מוסתרות.' }));
    return;
  }
  $('side-list').replaceChildren(...entries.map(([id, info]) => el('li', {},
    el('a', { href: safeUrl(info.url), target: '_blank', rel: 'noopener noreferrer', text: info.title || id }),
    el('div', { class: 'side-item-foot' },
      el('span', { class: 'muted', text: [info.company, info.at && new Date(info.at).toLocaleDateString('he-IL')].filter(Boolean).join(' · ') }),
      el('button', { class: 'btn link', type: 'button', text: 'בטל', onclick: () => mark(sideTab, id, null) })))));
}

function render() {
  store.set('filters', filters);
  const count = (key, value, ignore) => jobs.filter((j) => j[key] === value && matches(j, { ignore })).length;
  renderChips($('category-chips'), CATEGORIES, null, filters.categories, (c) => count('category', c, 'category'));
  renderChips($('level-chips'), LEVELS, LEVEL_LABELS, filters.levels, (l) => count('level', l, 'level'));

  visible = jobs.filter((j) => matches(j));
  if (filters.sort === 'company') visible.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  else visible.sort((a, b) => String(jobDate(b)).localeCompare(String(jobDate(a))));

  shown = 0;
  $('jobs').replaceChildren();
  $('result-count').textContent = jobs.length ? `מוצגות ${visible.length} משרות` : '';
  if (jobs.length && !visible.length) $('jobs').append(el('div', { class: 'empty', text: 'אין משרות שמתאימות לסינון הזה.' }));
  renderMore();
  renderStatus();
  renderSide();
}

// --- company search ---------------------------------------------------------

function sayCompany(text) {
  $('company-result').hidden = !text;
  $('company-result').textContent = text;
}

async function searchCompany(name, url) {
  sayCompany(`מחפש משרות ב-${name}…`);
  let hit = null;
  try { hit = await findCompany(name); } catch { /* treated as not found */ }

  if (hit) {
    const now = new Date().toISOString();
    const known = new Set(jobs.map((j) => j.id));
    const fresh = hit.jobs.filter((j) => !known.has(j.id)).map((j) => ({ ...j, firstSeen: now }));
    jobs = [...fresh, ...jobs];
    store.set('extraJobs', [...fresh, ...store.get('extraJobs', [])]);
    filters.search = '';
    $('search').value = '';
    render();

    let saved = '';
    if (token) {
      try {
        await updateFile(SITE_REPO, 'data/companies.json', [], (list) => (
          list.some((c) => c.ats === hit.company.ats && c.slug === hit.company.slug) ? list : [...list, hit.company]
        ), `add company ${name}`);
        saved = ' החברה נוספה לחיפוש הקבוע.';
      } catch { saved = ' לא הצלחתי להוסיף אותה לחיפוש הקבוע (בדוק את הרשאות הטוקן).'; }
    } else if (user) {
      try {
        await accounts.requestCompany(hit.company);
        saved = ' החברה תיכנס לחיפוש הקבוע בעדכון הקרוב.';
      } catch { saved = ' לא הצלחתי להוסיף אותה לחיפוש הקבוע. נסה שוב מאוחר יותר.'; }
    } else {
      saved = ' כדי שהחברה תיכנס לחיפוש הקבוע צריך להתחבר ל-GitHub (⚙ חיבור).';
    }
    const found = hit.jobs.length
      ? `נמצאו ${hit.jobs.length} משרות רלוונטיות ב-${name} (מתוך ${hit.israel} משרות בישראל), ${fresh.length} מהן חדשות ונוספו לרשימה.`
      : `ל-${name} יש ${hit.israel} משרות בישראל, אבל אף אחת לא מתאימה כרגע (תחום או ניסיון).`;
    sayCompany(found + saved);
    return;
  }

  if (!token && user) {
    try {
      await accounts.requestCompany({ name, url });
      store.set('sentRequests', [...store.get('sentRequests', []), { name, at: new Date().toISOString() }].slice(-10));
      sayCompany(`לא מצאתי את ${name} בחיפוש המהיר, אז שלחתי אותה לחיפוש מעמיק. הוא רץ כל כמה שעות, והתוצאה תופיע כאן למטה.`);
      loadRequests();
    } catch {
      sayCompany('לא הצלחתי לשלוח את הבקשה. נסה שוב מאוחר יותר.');
    }
    return;
  }
  if (!token) {
    sayCompany(`לא מצאתי את ${name} בחיפוש המהיר. חיפוש מעמיק דורש חיבור ל-GitHub (⚙ חיבור).`);
    return;
  }
  try {
    await updateFile(SITE_REPO, 'data/requests.json', [], (list) => [
      ...list.filter((r) => r.name.toLowerCase() !== name.toLowerCase()),
      { name, url: url || undefined, status: 'pending', requestedAt: new Date().toISOString() },
    ], `search company ${name}`);
    sayCompany(`לא מצאתי את ${name} בחיפוש המהיר, אז שלחתי אותה לחיפוש מעמיק. התוצאה תופיע כאן למטה תוך כמה דקות.`);
    loadRequests();
  } catch {
    sayCompany('לא הצלחתי לשלוח את הבקשה (בדוק את הרשאות הטוקן).');
  }
}

// Deep searches this user asked for: answered ones come from the file the
// collector publishes, the rest are still waiting for its next run.
async function accountRequests() {
  let published = [];
  try { published = await (await fetch(`data/requests.json?t=${Math.floor(Date.now() / 60000)}`)).json(); } catch { /* not published yet */ }
  const mine = published.filter((r) => r.by === user.uid && r.name);
  const waiting = store.get('sentRequests', []).filter((s) => Date.now() - new Date(s.at) < 2 * 86400000
    && !mine.some((r) => r.name.toLowerCase() === s.name.toLowerCase() && r.checkedAt > s.at));
  return [...mine, ...waiting.map((s) => ({ name: s.name, status: 'pending' }))];
}

async function loadRequests() {
  if (!token && !user) return;
  let list = [];
  try { list = token ? (await readFile(SITE_REPO, 'data/requests.json', [])).data : await accountRequests(); } catch { return; }
  const text = (r) => {
    if (r.status === 'pending') return `${r.name}: בחיפוש…`;
    if (r.status === 'found') return `${r.name}: נמצאו ${r.relevant} משרות רלוונטיות (מתוך ${r.israel} בישראל). החברה בחיפוש הקבוע.`;
    return `${r.name}: לא נמצא לוח משרות. אפשר לנסות שוב עם קישור לדף הקריירה.`;
  };
  $('requests').replaceChildren(...list.slice(-6).reverse().map((r) => el('li', { text: text(r) })));
  if (list.some((r) => r.status === 'pending')) setTimeout(loadRequests, token ? 30000 : 300000);
  else if (list.some((r) => r.status === 'found' && Date.now() - new Date(r.checkedAt) < 10 * 60000)) loadJobs();
}

// --- events -----------------------------------------------------------------

$('search').value = filters.search;
$('only-new').checked = filters.onlyNew;
$('show-seen').checked = filters.showSeen;
$('sort').value = filters.sort;

$('search').addEventListener('input', (e) => { filters.search = e.target.value.trim(); render(); });
$('only-new').addEventListener('change', (e) => { filters.onlyNew = e.target.checked; render(); });
$('show-seen').addEventListener('change', (e) => { filters.showSeen = e.target.checked; render(); });
$('sort').addEventListener('change', (e) => { filters.sort = e.target.value; render(); });
$('clear-filters').addEventListener('click', () => {
  Object.assign(filters, { categories: [], levels: [], search: '', onlyNew: false });
  $('search').value = '';
  $('only-new').checked = false;
  render();
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { sideTab = tab.dataset.tab; renderSide(); }));
$('open-applied').addEventListener('click', () => $('side').classList.add('open'));
$('close-side').addEventListener('click', () => $('side').classList.remove('open'));

$('company-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  await searchCompany($('company-name').value.trim(), $('company-url').value.trim());
  button.disabled = false;
});

$('open-settings').addEventListener('click', () => {
  if (!ACCOUNTS) return openTokenSettings();
  if (!user) return $('auth').showModal();
  $('account-email').textContent = user.email;
  $('account').showModal();
});
function openTokenSettings() {
  if (ACCOUNTS) $('settings-intro').textContent = 'למנהל המערכת בלבד: עם טוקן אישי, חברה שחיפשת נכנסת לחיפוש הקבוע מיד במקום בעדכון הבא.';
  $('token').value = token;
  $('settings-status').textContent = token ? 'מחובר.' : '';
  $('settings').showModal();
}
$('save-token').addEventListener('click', async () => {
  const candidate = $('token').value.trim();
  if (!candidate) return;
  const before = token;
  token = candidate;
  $('settings-status').textContent = 'בודק…';
  try {
    await github(`/repos/${OWNER}/${STATE_REPO}`);
    store.set('token', token);
    // Marks made before connecting move to GitHub with the first save.
    if (!before && !ACCOUNTS) {
      for (const kind of ['applied', 'seen']) for (const [id, value] of Object.entries(state[kind])) pendingOps.push({ kind, id, value });
      store.set('pendingOps', pendingOps);
    }
    $('settings').close();
    if (!ACCOUNTS) await pullState();
    loadRequests();
  } catch {
    token = before;
    $('settings-status').textContent = `הטוקן לא הצליח לגשת לריפו ${OWNER}/${STATE_REPO}. בדוק שבחרת בו את שני הריפוז עם הרשאת Contents: Read and write.`;
  }
});
$('disconnect').addEventListener('click', () => {
  token = '';
  store.set('token', '');
  if (!ACCOUNTS) {
    pendingOps = [];
    store.set('pendingOps', []);
  }
  $('settings').close();
  render();
});

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && shown < visible.length) renderMore();
}, { rootMargin: '600px' }).observe($('sentinel'));

// --- accounts ---------------------------------------------------------------

function setMarks(next, ops) {
  state = next;
  pendingOps = ops;
  store.set('state', state);
  store.set('pendingOps', pendingOps);
}

function onUser(next) {
  user = next;
  const lastUid = store.get('uid', '');
  if (!user) {
    // Signed out: the marks belong to the account, not to this browser.
    if (lastUid) setMarks(normalizeState(), []);
    store.set('uid', '');
    $('open-settings').textContent = 'כניסה';
    $('account').close();
    if (!$('auth').open) $('auth').showModal();
    render();
    return;
  }
  if (lastUid && lastUid !== user.uid) {
    setMarks(normalizeState(), []);
  } else if (!lastUid) {
    // First sign-in on this browser: marks made here so far move to the account.
    const ops = [];
    for (const kind of ['applied', 'seen']) for (const [id, value] of Object.entries(state[kind])) ops.push({ kind, id, value });
    setMarks(state, ops);
  }
  store.set('uid', user.uid);
  $('open-settings').textContent = `👤 ${user.email.split('@')[0]}`;
  $('auth').close();
  render();
  pullState();
  loadRequests();
}

async function authAction(action) {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  if (!email || (action !== 'reset' && !password)) {
    $('auth-status').textContent = action === 'reset' ? 'כתוב את האימייל שלך ולחץ שוב.' : 'צריך למלא אימייל וסיסמה.';
    return;
  }
  $('auth-status').textContent = 'רגע…';
  try {
    if (action === 'signup') await accounts.signUp(email, password);
    else if (action === 'signin') await accounts.signIn(email, password);
    else {
      await accounts.resetPassword(email);
      $('auth-status').textContent = 'אם יש חשבון עם האימייל הזה, נשלח אליו קישור לאיפוס הסיסמה.';
      return;
    }
    $('auth-password').value = '';
    $('auth-status').textContent = '';
  } catch (err) {
    $('auth-status').textContent = accounts.errorText(err);
  }
}

if (ACCOUNTS) {
  $('open-settings').textContent = store.get('uid', '') ? '👤' : 'כניסה';
  // The sign-in window stays until the user signs in.
  $('auth').addEventListener('cancel', (e) => e.preventDefault());
  $('auth-form').addEventListener('submit', (e) => { e.preventDefault(); authAction('signin'); });
  $('sign-up').addEventListener('click', () => authAction('signup'));
  $('reset-password').addEventListener('click', () => authAction('reset'));
  $('sign-out').addEventListener('click', () => accounts.signOut());
  $('open-token').addEventListener('click', () => { $('account').close(); openTokenSettings(); });
  accounts.start(onUser).catch(() => setSyncNote('לא הצלחתי להתחבר לשירות החשבונות. נסה לרענן את הדף.'));
}

render();
loadJobs();
pullState();
loadRequests();
