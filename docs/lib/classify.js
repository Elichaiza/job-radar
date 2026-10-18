// Shared by the site (browser) and the collector (Node): decides whether a
// posting is an Israeli, computer-science, 0-2 years job and tags it.

export const CATEGORIES = [
  'AI/ML', 'Data', 'Embedded', 'Hardware', 'Security', 'DevOps', 'QA',
  'Mobile', 'Fullstack', 'Frontend', 'Backend', 'Software',
];

// Order matters: the first category whose pattern matches the title wins.
const CATEGORY_RULES = [
  // Unmistakably embedded words win over "algorithm", "security" and the like.
  ['Embedded', /\b(embedded|firmware|fw|rtos|bsp|bare[- ]metal|mcu|microcontrollers?|device drivers?|bootloader|bios|uefi)\b/i],
  ['AI/ML', /\b(ai|ml|machine[- ]learning|deep[- ]learning|nlp|llm|gen[- ]?ai|computer vision|algorithms?|algo|data scien\w+|research scientist|applied scientist|mlops)\b/i],
  ['Data', /\b(data engineer\w*|data analyst|analytics engineer|bi developer|bi engineer|bi analyst|dba|database|data platform|data infrastructure|big data|etl)\b/i],
  ['Security', /\b(security|cyber\w*|malware|vulnerabilit\w+|reverse engineer\w*|penetration|pentest\w*|threat|red team|appsec|soc analyst)\b/i],
  ['Embedded', /\b(real[- ]?time|rt|kernel|drivers?|low[- ]level|linux|dsp|iot|robotics?|avionics|modem|phy|bluetooth|wireless|system software|systems programm\w+)\b/i],
  ['Hardware', /\b(verification|vlsi|fpga|asic|chip|physical design|rtl|dft|soc|board design|hardware|logic design|circuit|backend design|silicon|post[- ]silicon|pre[- ]silicon|dv|cad)\b/i],
  ['DevOps', /\b(devops|devsecops|sre|site reliability|platform engineer\w*|infrastructure|infra|cloud engineer\w*|release engineer\w*|production engineer\w*|ci\/cd|finops)\b/i],
  ['QA', /\b(qa|quality assurance|automation|test engineer\w*|tester|testing|sdet|validation|engineer in test)\b/i],
  ['Mobile', /\b(android|ios|mobile|react native|flutter)\b/i],
  ['Fullstack', /\bfull[- ]?stack\b/i],
  ['Frontend', /\b(front[- ]?end|react|angular|vue|ui developer|web developer|javascript|typescript)\b/i],
  ['Backend', /\b(back[- ]?end|server[- ]side|java|python|node(\.js)?|golang|go developer|scala|ruby|php|rust)\b|c\+\+|c#|\.net\b/i],
  ['Software', /./],
];

// A title has to look like a hands-on tech role...
const TECH_TITLE = /\b(software|sw|developer|programmer|r&d|rnd|back[- ]?end|front[- ]?end|full[- ]?stack|devops|devsecops|sre|site reliability|data scien\w+|data engineer\w*|data analyst|analytics engineer|machine[- ]learning|deep[- ]learning|ml|ai|algorithms?|algo|embedded|firmware|fw|rtos|bsp|bare[- ]metal|mcu|microcontrollers?|bootloader|bios|uefi|real[- ]?time|rt|low[- ]level|(device|kernel|gpu|windows) drivers?|drivers? (engineer|development)|iot|robotics?|avionics|modem|bluetooth|fpga|vlsi|asic|rtl|soc|silicon|chip|verification|validation|physical design|logic design|dsp|qa|automation|tester|sdet|engineer in test|researcher|research scientist|applied scientist|research engineer|android|ios|mobile|cyber\w*|security (engineer\w*|researcher|analyst|research)|malware|reverse engineer\w*|bi developer|bi engineer|bi analyst|dba|database administrator|dft|emulation|computer vision|nlp|llm|coder|computer science|cloud engineer\w*|platform engineer\w*|infrastructure engineer\w*|production engineer\w*|systems? software|linux|kernel|compiler|python|java|javascript|typescript|golang|node(\.js)?|react|angular|web|backend|simulation|gpu|networking|network engineer\w*|solutions? developer|technical lead)\b|c\+\+|c#|\.net\b|מפתח|מתכנת|תוכניתן|סייבר|למידת מכונה|בדיקות אוטומטיות|אוטומציה|דאטה|מהנדס\/?ת? תוכנה|תוכנה|בודק|אלגוריתמ/i;

// ...and not one of the "engineer"-named roles from other professions.
const NON_TECH_TITLE = /\b(sales|customer|supplier|spare parts|acceptance|mfg|npi|practical engineer\w*|electronics|applications? engineer\w*|quality & reliability|web content|web analyst|pre[- ]?sales?|account|marketing|recruit\w*|talent|hr|human resources|people partner|finance|financial|accountant|accounting|legal|counsel|customer success|customer support|customer service|customer experience|technical support|support engineer\w*|support specialist|solutions? engineer\w*|solutions? architect|solutions? consultant|field (application|service) engineer\w*|mechanical|electrical|civil|chemical|process engineer\w*|manufacturing|industrial|optical|optics|rf engineer\w*|analog|layout|facilit\w+|procurement|supply chain|logistics|buyer|payroll|bookkeeper|content writer|copywriter|designer|ux|product manager|product owner|project manager|program manager|scrum master|business analyst|business development|bizdev|bdr|sdr|partner\w*|office|administrat\w+|operations (manager|specialist|analyst)|technician|operator|assembler|warehouse|truck driver|delivery driver|bus driver|nurse|physician|clinical|regulatory|compliance|economist|lawyer|paralegal|translator|teacher|instructor|trainer|community|social media|seo|ppc|media buyer|campaign|growth marketing|technical writer)\b/i;

const SENIOR_TITLE = /\b(senior|sr|snr|staff|principal|lead|leader|manager|mgr|head|director|vp|vice president|chief|cto|cio|ciso|architect|expert|distinguished|fellow|experienced|team[- ]?lead|tech[- ]?lead|group[- ]?lead|iii|iv|mid[- ]senior)\b|בכיר|ראש צוות|מנהל|מוביל(\/?ת|\.ת)? (צוות|טכני|פרויקט)/i;
const INTERN_TITLE = /\b(intern|interns|internship|student|students|working student|co[- ]?op|trainee|apprentice)\b|סטודנט|מתמחה/i;
const JUNIOR_TITLE = /\b(junior|jr|entry[- ]level|graduate|new grad|grad|university grad\w*|early career|associate)\b|ג'וניור|בוגר/i;
const NO_EXP_TEXT = /\b(no (prior |previous |professional )?experience (is )?(required|needed|necessary)|recent graduates?|new graduates?|fresh graduates?|entry[- ]level|0\s*[-–]\s*[12]\s*years?)\b|ללא ניסיון|אין צורך בניסיון|בוגר טרי/i;

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NUM = '(\\d{1,2}(?:\\.\\d)?|one|two|three|four|five|six|seven|eight|nine|ten)';
// "3+ years", "2-4 years", "at least two years", "3 yrs"
const YEARS_EN = new RegExp(`${NUM}\\s*\\+?\\s*(?:(?:-|–|—|to)\\s*${NUM}\\s*\\+?\\s*)?(?:years?|yrs?)`, 'gi');
// "3+ שנים", "2-4 שנות", "שנתיים", "שנה"
const YEARS_HE = /(?:(\d{1,2})\s*\+?\s*(?:[-–]\s*(\d{1,2})\s*\+?\s*)?שנ(?:ים|ות|ה|ת)|(שנתיים)|(שנה))/g;
// Year counts that are not an experience requirement.
const NOT_EXPERIENCE = /\b(founded|established|since|for (over|more than)|over the (past|last)|in the (past|last)|years? old|year[- ]old|anniversary|degree|studies|remaining|left (in|to|until)|before graduat\w+|until graduat\w+|year students?|years? of stud\w+|warranty|contract|roadmap|history)\b|לסיום|לתואר|שנת לימוד|שנה [אבגד]'?(?:\s|$)|נוסדה|הוקמה/i;
const EXPERIENCE_WORD = /experience|background|expertise|hands[- ]on|practice|track record|working (with|as|in|on)|work(ed)? (with|as|in|on)|developing|development|programming|industry|professional|ניסיון|נסיון|וותק|ותק/i;

const toNumber = (s) => (s == null ? null : WORD_NUMBERS[s.toLowerCase()] ?? parseFloat(s));

const ISRAEL = /^\s*(il|isr)\s*$|\b(israel|tel[- ]?aviv|tlv|jaffa|yafo|herzliya|herzelia|haifa|jerusalem|ra'?anana|petah?[- ]tikva|petach[- ]tikva|netanya|rehovot|be'?er[- ]sheva|yokne'?am|kfar[- ]saba|hod[- ]hasharon|ramat[- ]gan|bnei[- ]brak|caesarea|rosh[- ]ha'?ayin|lod|airport city|holon|rishon[- ]le[- ]?zion|ness[- ]ziona|or[- ]yehuda|giv'?atayim|yakum|modi'?in|kiryat[- ]gat|migdal[- ]ha'?emek|nazareth|omer|ramat[- ]hasharon|tel[- ]hai|ashdod|ashkelon|karmiel|tefen|matam|even[- ]yehuda|kfar[- ]netter|bnei[- ]zion|shoham|yehud|azor|glil[- ]yam|hadera|afula|eilat|tirat[- ]carmel|nesher|kiryat[- ]shmona|misgav)\b|ישראל|תל אביב|חיפה|ירושלים|הרצליה|רעננה|פתח תקווה|נתניה|רחובות|באר שבע|יקנעם|רמת גן|כפר סבא|הוד השרון/i;
// "IL" is also Illinois, and a few city names exist elsewhere.
const NOT_ISRAEL = /\b(illinois|chicago|usa|united states|u\.s\.|india|germany|france|spain|uk|united kingdom|canada|poland|romania|ukraine|portugal|netherlands|singapore|japan|china|brazil|mexico|australia|ireland|italy|bulgaria|serbia|czech)\b/i;

export function isIsrael(location) {
  const text = Array.isArray(location) ? location.filter(Boolean).join(' | ') : String(location || '');
  if (!text) return false;
  // Multi-location postings count if any single location is Israeli.
  return text.split(/\s*[|;/]\s*|\s+or\s+/i).some((part) => ISRAEL.test(part) && !NOT_ISRAEL.test(part));
}

export function isTechTitle(title) {
  return TECH_TITLE.test(title) && !NON_TECH_TITLE.test(title);
}

export function isSeniorTitle(title) {
  return SENIOR_TITLE.test(title) && !INTERN_TITLE.test(title);
}

export function categorize(title) {
  return CATEGORY_RULES.find(([, re]) => re.test(title))[0];
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/<(br|\/p|\/li|\/div|\/h\d|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// Every "N years" in the text that reads as an experience requirement, as the
// lower bound of its range ("2-4 years" -> 2).
export function experienceMentions(text) {
  const mentions = [];
  const consider = (index, length, years) => {
    if (years == null || Number.isNaN(years) || years > 20) return;
    const line = lineAround(text, index, length);
    if (!EXPERIENCE_WORD.test(line) || NOT_EXPERIENCE.test(line)) return;
    mentions.push({ years, snippet: line.trim().slice(0, 160) });
  };
  for (const m of text.matchAll(YEARS_EN)) consider(m.index, m[0].length, toNumber(m[1]));
  for (const m of text.matchAll(YEARS_HE)) {
    consider(m.index, m[0].length, m[3] ? 2 : m[4] ? 1 : toNumber(m[1]));
  }
  return mentions;
}

function lineAround(text, index, length) {
  const start = Math.max(text.lastIndexOf('\n', index) + 1, index - 140);
  let end = text.indexOf('\n', index + length);
  if (end === -1 || end > index + length + 140) end = index + length + 140;
  return text.slice(start, end);
}

export const LEVELS = ['intern', 'entry', 'y1', 'y2', 'unknown'];

// Returns null when the posting asks for more than 2 years, otherwise
// { level, years, evidence }. levelHint is the board's own seniority field.
export function experienceLevel(title, text, levelHint = '') {
  const hint = String(levelHint || '');
  if (isSeniorTitle(title)) return null;
  if (/\b(senior|mid[- _]senior|director|executive|manager|lead|principal|staff)\b/i.test(hint)) return null;

  if (INTERN_TITLE.test(title) || /\bintern/i.test(hint)) {
    return { level: 'intern', years: 0, evidence: '' };
  }

  const mentions = experienceMentions(text);
  if (mentions.length) {
    // Several requirements in one posting: the strictest one is what matters.
    const top = mentions.reduce((a, b) => (b.years > a.years ? b : a));
    if (top.years > 2) return null;
    const level = top.years < 1 ? 'entry' : top.years <= 1 ? 'y1' : 'y2';
    return { level, years: top.years, evidence: top.snippet };
  }

  if (JUNIOR_TITLE.test(title) || /\b(entry|junior|associate|graduate)\b/i.test(hint)) {
    return { level: 'entry', years: 0, evidence: '' };
  }
  const noExp = text.match(NO_EXP_TEXT);
  if (noExp) return { level: 'entry', years: 0, evidence: lineAround(text, noExp.index, noExp[0].length).trim().slice(0, 160) };
  return { level: 'unknown', years: null, evidence: '' };
}

// raw: { title, location, description (html or text), levelHint }
// Returns the tags for a relevant job, or null if the job should be dropped.
export function classify(raw) {
  const title = String(raw.title || '').trim();
  if (!title || !isIsrael(raw.location) || !isTechTitle(title)) return null;
  const exp = experienceLevel(title, htmlToText(raw.description), raw.levelHint);
  if (!exp) return null;
  return { category: categorize(title), ...exp };
}
