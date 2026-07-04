// ============================================================
// Teamtailor Importera — content/work.js v3.17
// work.ua/employer/my/applicants/*
// ============================================================

// ── Утиліти безпечного HTML ──────────────────────────────
const _htmlEsc   = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Перевіряє що URL веде тільки на app.teamtailor.com (проти javascript: тощо)
const _ttSafeUrl = u => /^https:\/\/app\.teamtailor\.com\//.test(String(u || '')) ? u : '#';
// Безпечний URL для img src або <a href> до зовнішніх сайтів — дозволяємо лише http/https
const _safePic   = u => /^https?:\/\//i.test(String(u || '')) ? _htmlEsc(u) : '';

// ── Детектор прізвища за типовими українськими суфіксами ──
// Повертає true якщо одне слово виглядає як прізвище, а не ім'я.
// Використовується коли витягнуто лише одне слово — щоб класти його у lastName,
// а не firstName (помилка: "Краглік" йде в поле "Ім'я" замість "Прізвище").
function _looksLikeSurname(word) {
  if (!word || word.length < 3) return false;
  // Типові закінчення українських/польських прізвищ:
  // -ко/-ченко/-єнко/-єнко: Шевченко, Ковальченко
  // -ський/-цький/-зький та жіночі -ська/-цька/-зька: Іванський, Тимошевська
  // -чук/-щук/-юк/-ук: Тимощук, Тарасюк
  // -ик/-ік/-ець/-иць: Мельник, Краглік, Коваленець
  // -ів/-ів: Кравців, Дмитрів
  // -ова/-єва/-ева/-ов/-єв: Іванова, Соколов (русифіковані)
  // -ін/-ін/-ун/-ан (часті прізвища): Мартін, Кравчун
  return /(?:ченко|єнко|ієнко|ськ(?:ий|а|ого|ій)|цьк(?:ий|а|ого|ій)|зьк(?:ий|а|ого|ій)|чук|щук|юк(?:ів)?|чик|ик|ік|ець|иць|єць|ців|ьців|ова|єва|ева|ов|єв|ів(?:ська)?|ун|ин)$|ко$/i.test(word);
}

const FIXED_TAGS = [
  'work.ua',
  'alexandra (recruiter)', 'alexandra (recruiter/sourcer)',
  'anastasiia (recruiter)', 'daniela (recruiter)', 'daryna (recruiter)', 'daryna (sourcer)',
  'julia (sourcer)', 'maria (recruiter)', 'maryna (recruiter/sourcer)', 'oleksandra (sourcer)',
  'ruslana (recruiter)', 'serhii (recruiter)', 'sofia (recruiter)',
  'valentyna (sourcer)', 'victoriia (sourcer)'
];

let prefs         = {};
let selected      = new Set();
let checkCache    = new Map();
let detailCache   = new Map();

// ── Навігаційний авто-імпорт ──────────────────────────────
// Коли +TT клікнуто з картки списку — спочатку відкривається повний профіль
// кандидата (SPA-навігація), потім модалка авто-відкривається з повними даними.
let _pendingAutoImport = null; // { candidateId: string, tags: string[] }
let _bulkAutoState     = null; // { queue, current, progress, importedCandidates }
let responseCache = new Map(); // String(id) or 'cid:{candidate_id}' → API response item
const _workDupeRecheckDone = new Set(); // cids already re-checked with real contacts (avoid redundant checks)

// ── Bulk name check (IntersectionObserver) ────────────────
// Картки без контактів не перевіряються одразу — чекають поки стануть видимими.
// Всі видимі картки об'єднуються в один BULK_CHECK_NAMES запит (debounce 300мс).
const _nameBatchPending = new Map(); // name → [{candidateId, applyFn}]
let _nameBatchTimer = null;

async function _fireNameBatch() {
  if (!_nameBatchPending.size) return;
  const snapshot = [..._nameBatchPending.entries()];
  _nameBatchPending.clear();
  const names = snapshot.map(([name]) => name);
  try {
    const resp = await bgMsg({ type: 'BULK_CHECK_NAMES', names });
    if (!resp?.ok) return;
    for (const [name, items] of snapshot) {
      const dupe = resp.results?.[name] || null;
      for (const { applyFn } of items) applyFn(dupe);
    }
  } catch {}
}

function _queueNameCheck(name, candidateId, applyFn) {
  if (!_nameBatchPending.has(name)) _nameBatchPending.set(name, []);
  _nameBatchPending.get(name).push({ candidateId, applyFn });
  clearTimeout(_nameBatchTimer);
  _nameBatchTimer = setTimeout(_fireNameBatch, 300);
}

const _nameCheckObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    _nameCheckObserver.unobserve(entry.target);
    const p = entry.target._ttNameCheck;
    if (p) { delete entry.target._ttNameCheck; _queueNameCheck(p.name, p.candidateId, p.applyFn); }
  }
}, { rootMargin: '400px 0px' }); // 400px наперед — щоб бейдж з'явився до скролу

// ── Персистентний кеш дублів (між перезавантаженнями) ──────
// Кешуємо всі статуси між перезавантаженнями сторінки.
// TTL: red/orange → 48 год; green+контакти → 2 год; green+ім'я → 30 хв.
// При 50k кандидатів в TT це різко скорочує кількість API-викликів при повторних відвіданнях.
const DUPE_TTL_MS          = 48 * 60 * 60 * 1000;
const _WORK_GREEN_CONT_TTL =  2 * 60 * 60 * 1000; // 2 год якщо є phone/email
const _WORK_GREEN_NAME_TTL = 30 * 60 * 1000;       // 30 хв тільки ім'я
function _workDupeKey(cid) { return ('work_dupe_' + String(cid || '')).substring(0, 128); }

function persistWorkDupe(candidateId, status, ttData, hasContacts = false) {
  if (!candidateId || status === 'grey') return;
  const ttl = status === 'green'
    ? (hasContacts ? _WORK_GREEN_CONT_TTL : _WORK_GREEN_NAME_TTL)
    : DUPE_TTL_MS;
  chrome.storage.local.set({ [_workDupeKey(candidateId)]: { status, ttData: ttData || null, ts: Date.now(), ttl } });
}

function loadPersistedWorkDupe(candidateId) {
  return new Promise(resolve => {
    if (!candidateId) return resolve(null);
    chrome.storage.local.get(_workDupeKey(candidateId), result => {
      const entry = result[_workDupeKey(candidateId)];
      if (!entry) return resolve(null);
      const entryTtl = entry.ttl || DUPE_TTL_MS;
      if (Date.now() - (entry.ts || 0) > entryTtl) {
        chrome.storage.local.remove(_workDupeKey(candidateId));
        return resolve(null);
      }
      resolve(entry);
    });
  });
}

async function loadPrefs() {
  return new Promise(resolve => chrome.storage.local.get(null, r => { prefs = r || {}; resolve(); }));
}

function bgMsg(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) {
          // Service worker зупинився — чекаємо і пробуємо ще раз
          setTimeout(() => {
            try {
              chrome.runtime.sendMessage(msg, resp2 => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(resp2);
              });
            } catch(e) { reject(e); }
          }, 500);
        } else {
          resolve(resp);
        }
      });
    } catch(e) { reject(e); }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Preload відгуки через work.ua API ─────────────────────
// API work.ua: пагінація курсорна (last_id), НЕ offset-based.
// Завантажуємо до 150 відгуків (3 сторінки × 50) з правильним курсором.
async function preloadResponses() {
  try {
    const jobId = location.href.match(/[?&](?:job_id|jobId)=(\d+)/i)?.[1]
               || location.href.match(/\/vacancies?\/(\d+)/i)?.[1];

    // Завантажуємо ВСІ сторінки (без ліміту).
    // API work.ua повертає phone+email прямо в об'єкті відгуку (/jobs/responses).
    // Без повного завантаження кандидати після першої 150 не мають контактів у кеші.
    let lastId = null;
    for (;;) {
      const resp = await bgMsg({
        type:   jobId ? 'GET_WORK_RESPONSES' : 'GET_WORK_ALL_RESPONSES',
        jobId,
        limit:  50,
        lastId
      });

      if (!resp?.ok || !resp?.data?.items?.length) break;

      const items = resp.data.items;
      items.forEach(item => {
        const rid = String(item.id || '');
        const cid = String(item.candidate_id || '');
        if (rid) responseCache.set(rid, item);
        if (cid) responseCache.set(`cid:${cid}`, item);
      });

      if (items.length < 50) break; // остання сторінка

      lastId = items[items.length - 1]?.id || null;
      if (!lastId) break;
    }
  } catch (e) {}
}

// Знайти API-дані за candidateId картки
function lookupResponseData(candidateId) {
  const key = String(candidateId || '');
  return responseCache.get(key) || responseCache.get(`cid:${key}`) || null;
}

// Конвертувати API response item → detail object (phone, email, тощо)
// API docs: /jobs/responses та /jobs/{id}/responses повертають:
//   id, job_id, candidate_id, fio, email, phone, photo,
//   type ("resume"|"file"|"easy"), with_file, text, cover
function apiItemToDetail(item) {
  if (!item) return {};
  // ПІБ з API: "Прізвище Ім'я По-батькові" (fio) АБО окремі поля first_name/last_name
  const fio   = item.fio || item.full_name || item.fullName || '';
  const parts = fio.trim().split(/\s+/).filter(Boolean);

  // URL файлу резюме — work.ua повертає у полі file (object або string)
  const _fileUrl = (typeof item.file === 'string' ? item.file : '')
                || item.file?.url || item.file?.download_url || item.file?.path
                || item.file_url  || item.resume_url || item.download_url
                || '';

  // type: "resume"=онлайн резюме, "file"=прикріплений файл, "easy"=без резюме
  // with_file: 1 — є файл для завантаження (лише для type="file")
  const _type = item.type || '';
  const _isEasy = _type === 'easy'; // відгук без резюме — не намагаємось завантажити файл

  const detail = {
    phone:      item.phone ? normalizePhone(item.phone) : '',
    email:      item.email || '',
    picture:    item.photo || item.photo_url || '',
    // text = текст резюме (→ TT cover-letter), cover = супровідний лист
    resumeText: [item.text, item.cover].filter(Boolean).join('\n\n─────────\n').substring(0, 4500),
    withFile:   !_isEasy && (item.with_file === 1 || item.with_file === true || item.with_file === '1' || !!_fileUrl),
    responseType: _type,   // "resume" | "file" | "easy"
    jobId:      item.job_id       ? String(item.job_id)       : '',
    responseId: item.id           ? String(item.id)           : '',
    candidateId: item.candidate_id ? String(item.candidate_id) : '',
    resumeId:   item.resume_id    ? String(item.resume_id)    : '',
    resumeUrl:  _fileUrl,
  };

  // ПІБ: пріоритет — fio (Прізвище Ім'я), fallback — окремі поля first_name/last_name
  if (parts.length >= 2) {
    detail.lastName  = parts[0];
    detail.firstName = parts[1];
  } else if (parts[0] && _looksLikeSurname(parts[0])) {
    detail.lastName  = parts[0];
  } else if (parts[0]) {
    detail.firstName = parts[0];
  }
  // Fallback на окремі поля API якщо fio не дав результату
  if (!detail.firstName && item.first_name) detail.firstName = String(item.first_name).trim();
  if (!detail.lastName  && item.last_name)  detail.lastName  = String(item.last_name).trim();

  return detail;
}

// ── Extract from card ──────────────────────────────────────
function extractFromCard(card) {
  // Підтримуємо обидва формати: applicants/{id} (відгуки) та resumes/{id}/ (пошук резюме)
  const rawId      = card.id?.replace('candidate-', '').replace('resume-', '') || '';
  // Уникаємо /vacancies/{id}/applicants/ — це лінк на вакансію, не на кандидата
  const linkAppl   = card.querySelector('a[href*="/applicants/"]:not([href*="/vacancies/"])');
  const linkResume = card.querySelector('a[href*="/resumes/"]:not([href*="download"])');
  const linkEl     = linkAppl || linkResume;
  const href       = linkEl?.href || '';
  const hrefId     = href.match(/\/applicants\/(\d+)/)?.[1]
                  || href.match(/\/resumes\/(\d+)/)?.[1] || '';
  const candidateId = rawId || hrefId;

  // На /employer/my/applicants/ work.ua може рендерити назву вакансії з тим же класом
  // tw-font-semibold ДО імені кандидата. Тому спочатку шукаємо всередині посилання
  // на конкретного кандидата — назва вакансії знаходиться поза цим посиланням.
  // На /resumes/ h2 = назва посади (не ім'я!) — тому h2 > a іде в самий кінець як last-resort.
  const _nameSels = [
    'p.tw-truncate.tw-font-semibold',
    'p[class*="font-semibold"]',
    '[class*="tw-text-h4"]:not(h1):not(h2):not(h3)',
    'p[class*="truncate"]',
    '[data-test*="name"]',
  ].join(', ');
  // На /resumes/ сторінці (CleverStaff insight): h2 a[href][title] має
  // title="Зоряна Прізвище" (ім'я), а textContent="Главный бухгалтер" (посада).
  // Тому на /resumes/ читаємо title атрибут, а не textContent.
  let nameEl = null;
  let rawName = '';
  if (linkAppl) {
    nameEl = linkAppl.querySelector(_nameSels);
  } else if (linkResume) {
    // work.ua /resumes/: ім'я в <span class="strong-600"> (підтверджено на живій HTML-структурі).
    // h2 a[title] містить ПОСАДУ ("Менеджер з продажу, резюме від 24 червня 2026") — НЕ ім'я.
    const strongSpan = card.querySelector('span.strong-600, span[class*="strong-6"]');
    if (strongSpan) {
      rawName = strongSpan.textContent.trim();
    } else {
      // Fallback: рядок "Ім'я, вік, Місто" (кирилиця + цифри + рок/рік/літ)
      const ageLineEl = Array.from(card.querySelectorAll('p, span, b, strong'))
        .find(el => {
          const t = el.textContent.trim();
          return t.length < 80 && /^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{1,}/i.test(t)
                 && /\d+\s*(рок|рік|літ)/i.test(t);
        });
      if (ageLineEl) {
        rawName = ageLineEl.textContent.trim();
      }
    }
  }
  if (!rawName && !nameEl) {
    nameEl = card.querySelector([
      'p.tw-truncate.tw-font-semibold',
      'p[class*="font-semibold"]',
      '[class*="tw-text-h4"]:not(h1):not(h2):not(h3)',
      'p[class*="truncate"]',
      '[data-test*="name"]',
      '.name a', '.name',
      'p:first-of-type',
    ].join(', '));
  }
  // work.ua: ім'я може бути у форматі "Олександра, 44 роки, Київ"
  // Беремо лише частину до першої коми (і очищаємо зайве)
  if (!rawName) rawName = nameEl?.textContent?.trim() || '';
  // h2/h3 НЕ використовуємо як fallback — вони містять посаду, а не ім'я
  // Зачищаємо: "Сергій • Ветеран • 53 роки, Київ" → "Сергій"
  // Крапка-розділювач "•/·" на work.ua відокремлює ім'я від решти тексту картки
  let fullName = rawName
    .replace(/[•·●|].*/g, '')               // strip bullet separators (work.ua /resumes/ format)
    .replace(/,.*$/, '')                     // strip ", вік, місто"
    .replace(/\s*\d.*$/, '')                 // strip age/numbers ("53 роки" тощо)
    .replace(/\s*[-–—]\s*резюме\s*$/i, '')
    .trim();
  // Виправляємо злиття кириличних слів без пробілів (React/Angular SPA rendering):
  // "КубальськаОлена" → "Кубальська Олена", "ІваненкоІванІванович" → "Іваненко Іван Іванович"
  if (fullName && /[а-яґєіїьъ][А-ЯҐЄІЇЪ]/.test(fullName)) {
    fullName = fullName.replace(/([а-яґєіїьъ])([А-ЯҐЄІЇЪ])/g, '$1 $2').trim();
  }
  const parts    = fullName.trim().split(/\s+/);
  // Якщо одне слово — визначаємо по суфіксу: прізвище чи ім'я.
  // "Краглік" (суфікс -ік) → lastName; "Олег", "Марія" → firstName.
  let lastName, firstName;
  if (parts.length >= 2) {
    // work.ua може відображати "Яніслав Рязанов" (ім'я першим) або "Рязанов Яніслав" (прізвище першим).
    // Якщо parts[1] — прізвище, а parts[0] — ні → формат "ім'я прізвище".
    const _p0s = _looksLikeSurname(parts[0]);
    const _p1s = _looksLikeSurname(parts[1]);
    if (!_p0s && _p1s) {
      firstName = parts[0] || '';
      lastName  = parts[1] || '';
    } else {
      lastName  = parts[0] || '';
      firstName = parts[1] || '';
    }
  } else if (parts[0] && _looksLikeSurname(parts[0])) {
    lastName  = parts[0];
    firstName = '';
  } else {
    lastName  = '';
    firstName = parts[0] || '';
  }

  const photoEl   = card.querySelector('button span[style*="background-image"], span[style*="background-image"]');
  const styleStr  = photoEl?.getAttribute('style') || '';
  const photoMatch = styleStr.match(/url\("([^"]+)"\)/);
  const picture   = photoMatch ? photoMatch[1] : '';

  return { candidateId, firstName, lastName, fullName, picture, href };
}

// ── Нормалізація телефону ──────────────────────────────────
function normalizePhone(raw) {
  // Замінюємо Unicode-дефіси (–, —, −) на ASCII-дефіс перед обробкою
  const cleaned = raw.replace(/[‒–—−­]/g, '-').trim();
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.length === 12 && digits.startsWith('380')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('380')) return '+' + digits;
  return cleaned;
}

// ── DOM-based resume text extraction ──────────────────────
function extractResumeText(panel) {
  const RESUME_HEADINGS = new Set([
    'Досвід роботи', 'Освіта', 'Навички', 'Про себе',
    'Знання мов', 'Мови', 'Досягнення', 'Про кандидата',
    'Додаткова інформація', 'Курси та сертифікати',
  ]);

  // Primary: work.ua uses <h4 class="tw-text-h4 ...">SectionTitle</h4>
  // directly inside the section container div (div.tw-mt-lg.tw-border-t).
  // Search the whole document so findCandidatePanel() accuracy doesn't matter.
  const searchRoot = panel || document.body;
  const sectionBlocks = [];
  const seen = new WeakSet();

  for (const h of searchRoot.querySelectorAll('h4[class*="tw-text-h4"], h3[class*="tw-text-h4"], h2[class*="tw-text-h4"]')) {
    const text = h.textContent?.trim();
    if (!text || !RESUME_HEADINGS.has(text)) continue;
    // The direct parent is the section container (div.tw-mt-lg.tw-border-t)
    const block = h.parentElement;
    if (block && !seen.has(block)) { seen.add(block); sectionBlocks.push(block); }
  }

  if (sectionBlocks.length > 0) {
    const text = sectionBlocks.map(b => (b.innerText || '').trim()).filter(Boolean).join('\n\n');
    if (text.length > 50) return text.substring(0, 4000);
  }

  // Fallback: general heading search within panel
  if (panel) {
    const fallbackBlocks = [];
    const seenFb = new WeakSet();
    for (const el of panel.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const text = el.textContent?.trim();
      if (!text || !RESUME_HEADINGS.has(text)) continue;
      let block = el.parentElement;
      while (block && block !== panel) {
        const bLen = (block.innerText || '').trim().length;
        if (bLen >= text.length + 50) {
          const pLen = (block.parentElement?.innerText || '').trim().length;
          if (pLen > bLen * 1.3 || block.parentElement === panel) {
            if (!seenFb.has(block)) { seenFb.add(block); fallbackBlocks.push(block); }
            break;
          }
        }
        block = block.parentElement;
      }
    }
    if (fallbackBlocks.length > 0) {
      const unique = fallbackBlocks.filter(b => !fallbackBlocks.some(o => o !== b && b.contains(o)));
      const text = unique.map(b => (b.innerText || '').trim()).filter(Boolean).join('\n\n');
      if (text.length > 50) return text.substring(0, 4000);
    }
  }

  // Last resort: whole-panel text with UI-noise filtering
  if (!panel) return '';
  const fullText = panel.innerText || '';
  const stopIdx = fullText.indexOf('Згорнути');
  const textToProcess = stopIdx > 200 ? fullText.substring(0, stopIdx) : fullText;
  const skipRe = /^(Нові|Відгук|Запрошення|Зацікавлені|Рекомендовані|Прийнятий|Відмова|Всі|події|\d+|\d+\s*кандидат)$|^\d+%$|\d+\s+\w+\s+\d{4}·/i;
  const skipTexts = [
    'Завантажити', 'Роздрукувати', 'Змінити етап', 'Написати',
    'Нагадування', 'Не підходить', 'Співбесіда', 'Не відповідає',
    'Неактуально', 'Не прийшов', 'Додати в Teamtailor', 'Подивитися на мапі',
    'Вибрати іншу вакансію', 'непереглянутий',
    'Шукати в Telegram', 'Шукати в Viber', 'Шукати в WhatsApp', 'Шукати в Whatsapp',
    'Ел. пошта', 'Пошук у соцмережах', 'Телефон підтверджено',
    'надає перевагу', 'переглянув', 'пропозицій від роботодавців',
    'Резюме та відгуки', 'Відгук на вакансію', 'Додайте коментар',
    'Ще проходить', 'Виникла помилка',
    'Послуги Work.ua', 'Умови використання', 'Тільки непереглянуті',
  ];
  const lines = textToProcess
    .split('\n').map(l => l.trim())
    .filter(l => l.length > 3 && !skipRe.test(l) && !skipTexts.some(t => l.includes(t)));
  return lines.join('\n').substring(0, 4000);
}

// ── Extract from detail panel ──────────────────────────────
function extractFromDetailPanel() {
  let phone   = '';
  let email   = '';
  let picture = '';

  // Шукаємо в документі — права панель це звичайний DOM
  const root = document;

  // Телефон: перевіряємо кілька можливих DOM-структур work.ua
  const _looksPhone = (txt) => {
    if (!txt) return false;
    // Нормалізуємо Unicode-дефіси (en-dash –, em-dash —, minus −) → ASCII-дефіс
    const norm = txt.replace(/[‒–—−­]/g, '-').trim();
    // Відкидаємо будь-який текст з літерами (назви, зарплата з "грн", тощо)
    if (/[a-zA-Zа-яА-ЯіІїЇєЄ]/.test(norm)) return false;
    const digits = norm.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 12) return false;
    // Українські номери: починаються з '0' (локальний) або '+' або '380'
    return norm[0] === '0' || norm[0] === '+' ||
           (digits.startsWith('38') && digits.length === 12);
  };

  // 0. Точні селектори work.ua employer portal (підтверджено в DevTools)
  // Телефон: span.tw-text-h4 / span.tw-text-h4.tw-font-normal
  // ВАЖЛИВО: коли є іконки месенджерів, вони — дочірні spans усередині span.tw-text-h4.
  // Тому НЕ перевіряємо children.length — натомість читаємо перший TEXT_NODE (сам номер).
  if (!phone) {
    for (const el of root.querySelectorAll('span.tw-text-h4, span[class*="tw-text-h4"]')) {
      let txt = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { txt = node.textContent.trim(); if (txt) break; }
      }
      if (!txt) txt = el.textContent.replace(/\s+/g, ' ').trim();
      if (_looksPhone(txt)) { phone = normalizePhone(txt); break; }
    }
  }
  // Email: <button class="...ga-ats-copy-candidate-email..."><span>email</span>...
  if (!email) {
    const _copyBtn = root.querySelector('button[class*="ga-ats-copy-candidate-email"], button[class*="copy-candidate-email"]');
    if (_copyBtn) {
      const _sp = _copyBtn.querySelector('span');
      const _txt = _sp?.textContent?.trim() || '';
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_txt)) email = _txt;
    }
  }

  // 1. Пряме посилання tel: — найнадійніший варіант
  const phoneLink = root.querySelector('a[href^="tel:"]');
  if (!phone && phoneLink) {
    const _rawTel = phoneLink.href.replace('tel:', '').trim();
    if (_rawTel) phone = normalizePhone(_rawTel);
  }

  // 2. Після мітки "Телефон" — наступний елемент або текстовий вузол з номером
  if (!phone) {
    const _phoneLabelEl = [...root.querySelectorAll('p, span, div, label')]
      .find(el => el.children.length === 0 && /телефон/i.test(el.textContent));
    if (_phoneLabelEl) {
      // Шукаємо серед сусідів і нащадків батьківського елемента
      const _parent = _phoneLabelEl.parentElement;
      if (_parent) {
        for (const el of _parent.querySelectorAll('p, span, div, a')) {
          if (el === _phoneLabelEl) continue;
          // Перший текстовий вузол (телефон + іконки месенджерів)
          const _ft = el.childNodes[0];
          if (_ft?.nodeType === Node.TEXT_NODE) {
            const _t = _ft.textContent.trim();
            if (_looksPhone(_t)) { phone = normalizePhone(_t); break; }
          }
          if (el.children.length === 0) {
            const _t = el.textContent.trim();
            if (_looksPhone(_t)) { phone = normalizePhone(_t); break; }
          }
        }
      }
    }
  }

  // 3. Перший текстовий вузол елемента (навіть якщо є дочірні іконки)
  if (!phone) {
    for (const el of root.querySelectorAll('p, span, div')) {
      const firstText = el.childNodes[0];
      if (!firstText || firstText.nodeType !== Node.TEXT_NODE) continue;
      const txt = firstText.textContent.trim();
      if (_looksPhone(txt)) { phone = normalizePhone(txt); break; }
    }
  }

  // 4. span.tw-text-h4 / span з класом h4 — work.ua рендерить номер саме тут
  if (!phone) {
    for (const el of root.querySelectorAll(
      'span.tw-text-h4, span[class*="tw-text-h4"], p.tw-text-h4, p[class*="tw-font-bold"]'
    )) {
      const txt = el.textContent.trim();
      if (_looksPhone(txt)) { phone = normalizePhone(txt); break; }
    }
  }

  // 5. Будь-який елемент що виглядає як номер телефону (лише текст без дочірніх)
  if (!phone) {
    for (const el of root.querySelectorAll('p, span, div, li, td')) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (_looksPhone(txt)) { phone = normalizePhone(txt); break; }
    }
  }

  // 6. TreeWalker — ядерний варіант: перебираємо КОЖЕН текстовий вузол у DOM.
  // Знаходить телефон незалежно від структури елементів і класів.
  if (!phone) {
    const _walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let _node;
    while ((_node = _walker.nextNode())) {
      const _t = _node.textContent.trim();
      if (_looksPhone(_t)) { phone = normalizePhone(_t); break; }
    }
  }

  // Email: кілька варіантів структури
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // 1. Пряме посилання mailto: — найнадійніший варіант
  const emailLink = root.querySelector('a[href^="mailto:"]');
  if (emailLink) email = emailLink.href.replace('mailto:', '').trim();

  // 2. p/span що містять @ (без дочірніх елементів)
  if (!email) {
    const emailCandidates = root.querySelectorAll(
      'p.tw-mb-sm, p[class*="tw-break"], p[class*="tw-text-muted"], p[class*="break-all"], span'
    );
    for (const el of emailCandidates) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (emailRegex.test(txt) && txt.length < 80) { email = txt; break; }
    }
  }

  // 3. Загальний fallback — будь-який текст що схожий на email
  if (!email) {
    for (const el of root.querySelectorAll('p, span, div, li, td')) {
      if (el.children.length > 0) continue;
      const txt = el.textContent.trim();
      if (emailRegex.test(txt) && txt.length < 80) { email = txt; break; }
    }
  }

  // Фото
  const photoEl = root.querySelector('img[src*="i.work.ua"], img[src*="sent_photo"]');
  if (photoEl?.src && /^https?:\/\//i.test(photoEl.src)) picture = photoEl.src;

  let resumeText = '';
  try { resumeText = extractResumeText(findCandidatePanel()); } catch (e) {}

  return { phone, email, picture, resumeText };
}

// ── Клікнути на картку і дочекатись контактів ─────────────
async function clickCardAndWait(candidateId) {
  const card = document.querySelector(`#candidate-${candidateId}`)
            || document.querySelector(`#resume-${candidateId}`);
  if (!card) return null;

  // Тільки /applicants/ посилання відкривають бічну панель (без навігації).
  // /resumes/ посилання навігують до профілю — їх НЕ клікаємо.
  const link = card.querySelector('a[href*="/applicants/"]');
  if (!link) return null;

  link.click();

  const phoneRe = /^[\+\d][\d\s\-]{6,18}$/;
  const emailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const spans = [...document.querySelectorAll('span.tw-text-h4, p.tw-font-normal, p.tw-break-all')];
    const hasPhone = spans.some(el => el.children.length === 0 && phoneRe.test(el.textContent.trim()));
    const hasEmail = spans.some(el => emailRe.test(el.textContent.trim()));
    if (hasPhone || hasEmail) break;
  }
  await sleep(300);
  return extractFromDetailPanel();
}

// ── Badge ──────────────────────────────────────────────────
// Хелпер: встановлює тултіп з посиланням, яке не пробиває кліки на сторінку
function _setTooltipDupe(tooltip, emoji, label, url, name) {
  tooltip.textContent = '';
  tooltip.appendChild(document.createTextNode(`${emoji} ${label} — `));
  const a = document.createElement('a');
  a.href = _ttSafeUrl(url);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = name || '';
  a.addEventListener('click', e => e.stopPropagation());
  a.addEventListener('mousedown', e => e.stopPropagation());
  tooltip.appendChild(a);
}

function createBadgeWrap(candidateId) {
  const wrap = document.createElement('div');
  wrap.className = 'tt-badge-wrap';
  // FIX: використовуємо flex в рядок, без absolute щоб не перекривати
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:6px;vertical-align:middle;flex-shrink:0;';

  const cb = document.createElement('div');
  cb.className = 'tt-checkbox';
  cb.style.cssText = 'width:14px;height:14px;flex-shrink:0;';
  if (selected.has(candidateId)) cb.classList.add('checked');
  cb.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    selected.has(candidateId)
      ? (selected.delete(candidateId), cb.classList.remove('checked'))
      : (selected.add(candidateId),   cb.classList.add('checked'));
    updateBulkBar();
  });
  wrap.appendChild(cb);

  const dot = document.createElement('div');
  dot.className = 'tt-dot loading';
  dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
  const tooltip = document.createElement('div');
  tooltip.className = 'tt-tooltip';
  tooltip.textContent = '⏳ Перевіряю...';
  dot.appendChild(tooltip);
  wrap.appendChild(dot);

  return { wrap, dot, tooltip, cb };
}

// ── Process card ───────────────────────────────────────────
async function processCard(card) {
  if (card.dataset.ttProcessed) return;
  card.dataset.ttProcessed = '1';

  const info = extractFromCard(card);
  if (!info.candidateId || !info.fullName) return;

  const { wrap, dot, tooltip } = createBadgeWrap(info.candidateId);

  // Вставляємо badge ПОЗА <a> тегом — якщо badge всередині <a>, SPA-роутер work.ua
  // при будь-якому кліку знаходить e.target.closest('a[href]') і навігує, ігноруючи
  // наш stopPropagation (роутер слухає на document/window рівні через capture або delegation).
  const _appLink     = card.querySelector('a[href*="/applicants/"]');
  const nameInlineEl = (_appLink && _appLink.querySelector('p.tw-truncate.tw-font-semibold, p[class*="font-semibold"]'))
                    || card.querySelector('p.tw-truncate.tw-font-semibold, p[class*="font-semibold"]');
  const parentLink   = nameInlineEl?.closest('a[href]');

  if (parentLink?.parentElement) {
    // Вставляємо бейдж як сусіда <a> (після нього) — поза посиланням
    const linkParent = parentLink.parentElement;
    linkParent.style.position = 'relative';
    wrap.style.cssText = 'position:absolute;top:50%;right:8px;transform:translateY(-50%);display:inline-flex;align-items:center;gap:4px;z-index:9999;';
    linkParent.insertBefore(wrap, parentLink.nextSibling);
  } else if (nameInlineEl) {
    // Немає <a> батька — вставляємо inline поруч з іменем (безпечно)
    nameInlineEl.style.display = 'inline-flex';
    nameInlineEl.style.alignItems = 'center';
    nameInlineEl.appendChild(wrap);
  } else {
    // Fallback: абсолютна позиція в картці
    card.style.position = 'relative';
    wrap.style.cssText = 'position:absolute;top:6px;right:6px;z-index:9999;display:flex;align-items:center;gap:4px;';
    card.appendChild(wrap);
  }

  // Беремо телефон/email із responseCache (preload міг вже заповнити)
  const _preItem = lookupResponseData(info.candidateId);
  const _pre     = _preItem ? apiItemToDetail(_preItem) : {};
  const badgePhone = _pre.phone || '';
  const badgeEmail = _pre.email || '';

  // ── Відновлення з персистентного кешу ─────────────────────
  // Показуємо кешований статус одразу (швидкий UX).
  // Фоновий ре-чек — тільки для red/orange старіших 4 год (перевірка що ще є в TT).
  // Green entries expire швидко (2 год / 30 хв) → ре-чек зайвий.
  // ── Спільний обробник кліку +TT ────────────────────────────────────────────
  // Використовується ВСІМА +TT кнопками (cached green/orange і новою перевіркою).
  // Проблема v5.5.31: cached кнопки викликали openImportModal(info) напряму —
  // без витягування телефону. Тепер вся логіка тут.
  const _doTtClick = async () => {
    const _getCurId = () => location.href.match(/\/applicants\/(\d+)/)?.[1]
                          || location.href.match(/\/responses\/(\d+)/)?.[1];

    const _alreadyOnProfile = _getCurId() === info.candidateId;
    if (!_alreadyOnProfile) {
      const _liveCard = document.querySelector(`#candidate-${CSS.escape(String(info.candidateId))}`);
      const _navLink  = _liveCard?.querySelector(`a[href*="/applicants/"], a[href*="/responses/"]`)
                     || card.querySelector(`a[href*="/applicants/${info.candidateId}"], a[href*="/responses/${info.candidateId}"]`);
      if (_navLink) _navLink.click();
    }

    const _apiItem = lookupResponseData(info.candidateId);
    let detail = { ...(detailCache.get(info.candidateId) || {}), ...(_apiItem ? apiItemToDetail(_apiItem) : {}) };

    if (!detail.phone && !detail.email) {
      const _phoneRe = /^[\+\d][\d\s\-–—]{6,18}$/;
      if (_alreadyOnProfile) {
        const _pd = extractFromDetailPanel();
        if (_pd.phone || _pd.email) detail = { ...detail, ..._pd };
      } else {
        // Поллимо появу span.tw-text-h4 з контентом (як clickCardAndWait у v4.0.1)
        for (let _i = 0; _i < 25; _i++) {
          await new Promise(r => setTimeout(r, 300));
          const _spans = [...document.querySelectorAll('span.tw-text-h4, span[class*="tw-text-h4"]')];
          const _hasPhone = _spans.some(el => {
            const _ft = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
            return _ft && _phoneRe.test(_ft.textContent.trim());
          });
          const _hasEmail = !!document.querySelector('a[href^="mailto:"], button[class*="copy-candidate-email"]');
          if (_hasPhone || _hasEmail) break;
        }
        await new Promise(r => setTimeout(r, 300));
        const _pd = extractFromDetailPanel();
        if (_pd.phone || _pd.email) detail = { ...detail, ..._pd };
      }
    }

    const resumeUrl  = detail.resumeUrl || findResumeLink()?.href || '';
    const _cached    = checkCache.get(info.candidateId);
    const mergedInfo = { ...info, ...detail, resumeUrl, workUrl: info.href, ttData: _cached?.ttData || null };

    let knownDupe = (_cached?.status === 'orange' || _cached?.status === 'red') ? _cached?.ttData : null;
    if (!knownDupe && (detail.phone || detail.email)) {
      try {
        const dupeResp = await bgMsg({
          type: 'CHECK_DUPLICATE',
          phone: detail.phone || '', email: detail.email || '',
          name: `${info.firstName} ${info.lastName}`.trim()
        });
        if (dupeResp?.dupe) knownDupe = dupeResp.dupe;
      } catch (_) {}
    }

    if (knownDupe) {
      persistWorkDupe(info.candidateId, 'red', knownDupe);
      checkCache.set(info.candidateId, { status: 'red', ttData: knownDupe, info });
      dot.className = 'tt-dot red';
      _setTooltipDupe(tooltip, '🔴', 'Є в TT', knownDupe.url, knownDupe.name);
      wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
      openDupePopup(
        knownDupe, mergedInfo,
        () => openImportModal(mergedInfo, _cached?.status || 'green'),
        (result) => {
          const _cId = result?.candidateId || '';
          if (_cId) {
            const _nd = { id: _cId, name: `${info.firstName||''} ${info.lastName||''}`.trim(),
                          url: result.url || `https://app.teamtailor.com/candidates/${_cId}`,
                          email: detail.email||'', phone: detail.phone||'' };
            persistWorkDupe(info.candidateId, 'red', _nd);
            checkCache.set(info.candidateId, { status: 'red', ttData: _nd, info });
            dot.className = 'tt-dot red';
            const _t2 = dot.querySelector('.tt-tooltip');
            if (_t2) _t2.innerHTML = `🔴 Є в TT — <a href="${_ttSafeUrl(_nd.url)}" target="_blank">${_htmlEsc(_nd.name)}</a>`;
            wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
          }
        }
      );
    } else {
      openImportModal(mergedInfo, _cached?.status || 'green');
    }
  };

  // ── Ручний ре-чек (кнопка 🔄 у тултіпі) ─────────────────────────────────────
  // Дозволяє скинути кеш "червоний/помаранчевий" одразу — без очікування 4 год.
  // Потрібно: видалили кандидата з TT → dot досі red → клік 🔄 → перевіряє знову.
  const _runRecheckNow = async () => {
    dot.className = 'tt-dot loading';
    tooltip.textContent = '⏳ Перевіряю...';
    try {
      const _r = await bgMsg({ type: 'CHECK_DUPLICATE',
        phone: badgePhone, email: badgeEmail,
        name: `${info.firstName} ${info.lastName}`.trim() });
      if (!_r) { dot.className = 'tt-dot red'; return; }
      if (!_r.dupe) {
        chrome.storage.local.remove(_workDupeKey(info.candidateId));
        checkCache.delete(info.candidateId);
        dot.className = 'tt-dot green';
        dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
        tooltip.textContent = '✅ Немає в Teamtailor';
        wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
        const _nb = document.createElement('button');
        _nb.type = 'button'; _nb.className = 'tt-btn';
        _nb.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
        _nb.textContent = '+TT';
        _nb.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _doTtClick(); });
        wrap.appendChild(_nb);
      } else {
        persistWorkDupe(info.candidateId, 'red', _r.dupe);
        checkCache.set(info.candidateId, { status: 'red', ttData: _r.dupe, info });
        dot.className = 'tt-dot red';
        _setTooltipDupe(tooltip, '🔴', 'Є в TT', _r.dupe.url, _r.dupe.name);
        _addRecheckBtn();
      }
    } catch (_) { dot.className = 'tt-dot red'; }
  };
  const _addRecheckBtn = () => {
    const _rb = document.createElement('button');
    _rb.type = 'button'; _rb.textContent = '🔄'; _rb.title = 'Перевірити знову';
    _rb.style.cssText = 'background:none;border:none;color:#74b9ff;cursor:pointer;font-size:11px;padding:0 0 0 6px;line-height:1;vertical-align:middle;';
    _rb.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _runRecheckNow(); });
    tooltip.appendChild(_rb);
  };

  const persisted = await loadPersistedWorkDupe(info.candidateId);
  if (persisted) {
    checkCache.set(info.candidateId, { status: persisted.status, ttData: persisted.ttData, info });
    dot.className = `tt-dot ${persisted.status}`;
    dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
    if (persisted.status === 'red')    { _setTooltipDupe(tooltip, '🔴', 'Є в TT', persisted.ttData?.url, persisted.ttData?.name); _addRecheckBtn(); }
    else if (persisted.status === 'orange') { _setTooltipDupe(tooltip, '🟠', 'Дані різняться', persisted.ttData?.url, persisted.ttData?.name); _addRecheckBtn(); }
    else if (persisted.status === 'green') {
      tooltip.textContent = '✅ Немає в Teamtailor';
      // Кнопка +TT для green (відновлена з кешу — кандидата ще немає в TT)
      if (!wrap.querySelector('.tt-btn')) {
        const _cacheBtn = document.createElement('button');
        _cacheBtn.type = 'button';
        _cacheBtn.className = 'tt-btn';
        _cacheBtn.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
        _cacheBtn.textContent = '+TT';
        _cacheBtn.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _doTtClick(); });
        wrap.appendChild(_cacheBtn);
      }
    }
    // Ре-чек тільки red/orange, що старіші 4 год
    const _recheckAge = Date.now() - (persisted.ts || 0);
    if (persisted.status !== 'green' && _recheckAge > 4 * 60 * 60 * 1000) {
      bgMsg({ type: 'CHECK_DUPLICATE', phone: badgePhone, email: badgeEmail,
              name: `${info.firstName} ${info.lastName}`.trim() })
        .then(resp => {
          if (!resp) return;
          if (!resp.dupe) {
            chrome.storage.local.remove(_workDupeKey(info.candidateId));
            checkCache.delete(info.candidateId);
            dot.className = 'tt-dot green';
            dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
            tooltip.textContent = '✅ Немає в Teamtailor';
            wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
            const _newBtn = document.createElement('button');
            _newBtn.type = 'button';
            _newBtn.className = 'tt-btn';
            _newBtn.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
            _newBtn.textContent = '+TT';
            _newBtn.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _doTtClick(); });
            wrap.appendChild(_newBtn);
          } else if (resp.dupe.id !== persisted.ttData?.id) {
            persistWorkDupe(info.candidateId, 'red', resp.dupe);
            checkCache.set(info.candidateId, { status: 'red', ttData: resp.dupe, info });
            dot.className = 'tt-dot red';
            _setTooltipDupe(tooltip, '🔴', 'Є в TT', resp.dupe.url, resp.dupe.name);
          }
        }).catch(() => {});
    } // end if (_recheckAge > 4h)
    return;
  }

  const _wHadContacts = !!(badgePhone || badgeEmail);

  const _wFn = info.firstName || '';
  const _wLn = info.lastName  || '';
  const _wNameOrder1 = [_wFn, _wLn].filter(Boolean).join(' ');
  const _wNameOrder2 = [_wLn, _wFn].filter(Boolean).join(' ');

  const _applyWorkDupe = async (resp) => {
    if (!resp?.dupe) {
      persistWorkDupe(info.candidateId, 'green', null, _wHadContacts);
      checkCache.set(info.candidateId, { status: 'green', ttData: null, info });
      dot.className = 'tt-dot green';
      dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
      tooltip.textContent = '✅ Немає в Teamtailor';
      if (!wrap.querySelector('.tt-btn')) {
        const _nb = document.createElement('button');
        _nb.type = 'button'; _nb.className = 'tt-btn';
        _nb.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
        _nb.textContent = '+TT';
        _nb.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _doTtClick(); });
        wrap.appendChild(_nb);
      }
      return;
    }
    if (checkCache.get(info.candidateId)?.status === 'red') return;
    let _st = 'red';
    let _td = resp.dupe;
    try {
      const cmpResp = await bgMsg({ type: 'COMPARE_WITH_TT', ttId: resp.dupe.id, candidate: {
        phone: badgePhone, email: badgeEmail
      } });
      if (cmpResp?.result?.hasDiffs) _st = 'orange';
    } catch (_) {}
    persistWorkDupe(info.candidateId, _st, _td, _wHadContacts);
    checkCache.set(info.candidateId, { status: _st, ttData: _td, info });
    dot.className = `tt-dot ${_st}`;
    dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
    if (_st === 'red')    _setTooltipDupe(tooltip, '🔴', 'Є в TT', _td?.url, _td?.name);
    else if (_st === 'orange') _setTooltipDupe(tooltip, '🟠', 'Дані різняться', _td?.url, _td?.name);
    wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
    if (_st === 'red' && _td?.url) {
      const _lnk = document.createElement('a');
      _lnk.href = _td.url; _lnk.target = '_blank';
      _lnk.className = 'tt-btn';
      _lnk.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;text-decoration:none;';
      _lnk.textContent = '↗ TT';
      _lnk.addEventListener('click', e => e.stopPropagation());
      wrap.appendChild(_lnk);
    } else if (_st === 'orange') {
      const _updBtn = document.createElement('button');
      _updBtn.type = 'button';
      _updBtn.className = 'tt-btn update';
      _updBtn.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
      _updBtn.textContent = '↺ TT';
      _updBtn.addEventListener('click', async e => {
        e.stopPropagation(); e.preventDefault();
        await _doTtClick();
      });
      wrap.appendChild(_updBtn);
    }
  };

  // Є контакти → CHECK_DUPLICATE (GraphQL/phone, через семафор).
  // Лише ім'я → IntersectionObserver + BULK_CHECK_NAMES (видимі картки → один batch-запит).
  if (_wHadContacts) {
    bgMsg({ type: 'CHECK_DUPLICATE', phone: badgePhone, email: badgeEmail, name: _wNameOrder1 })
      .then(_applyWorkDupe).catch(() => {});
  } else if (_wNameOrder1) {
    card._ttNameCheck = {
      name: _wNameOrder1,
      candidateId: info.candidateId,
      applyFn: (dupe) => { if (dupe) _applyWorkDupe({ dupe }); else _applyWorkDupe(null); }
    };
    _nameCheckObserver.observe(card);
  }

  // Початковий рендер — loading (оновиться після CHECK_DUPLICATE).
  dot.className = 'tt-dot orange';
  dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
  tooltip.textContent = '⏳ Перевіряю...';

  // Додатковий re-check якщо панель відкрита і в preload не було контактів
  if (!_wHadContacts) {
    const _panelId = location.href.match(/\/applicants\/(\d+)/)?.[1]
                  || location.href.match(/\/responses\/(\d+)/)?.[1];
    if (_panelId === info.candidateId && !_workDupeRecheckDone.has(info.candidateId)) {
      setTimeout(() => {
        const _pd = extractFromDetailPanel();
        if (!_pd.phone && !_pd.email) return;
        _workDupeRecheckDone.add(info.candidateId);
        dot.className = 'tt-dot orange';
        tooltip.textContent = '⏳ Перевіряю...';
        const _existBtn = wrap.querySelector('.tt-btn');
        if (_existBtn) _existBtn.disabled = true;
        bgMsg({ type: 'PANEL_CHECK_DUPLICATE',
                phone: _pd.phone || '', email: _pd.email || '',
                name: `${info.firstName} ${info.lastName}`.trim() })
          .then(resp => {
            if (_existBtn) _existBtn.disabled = false;
            if (!resp?.dupe) {
              dot.className = 'tt-dot green';
              tooltip.textContent = '✅ Немає в Teamtailor';
              return;
            }
            const _dup = resp.dupe;
            persistWorkDupe(info.candidateId, 'red', _dup, true);
            checkCache.set(info.candidateId, { status: 'red', ttData: _dup, info });
            dot.className = 'tt-dot red';
            _setTooltipDupe(tooltip, '🔴', 'Є в TT', _dup.url, _dup.name);
            wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
            if (_dup.url) {
              const _lnk = document.createElement('a');
              _lnk.href = _dup.url; _lnk.target = '_blank';
              _lnk.className = 'tt-btn';
              _lnk.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;text-decoration:none;';
              _lnk.textContent = '↗ TT';
              _lnk.addEventListener('click', e => e.stopPropagation());
              wrap.appendChild(_lnk);
            }
          }).catch(() => { if (_existBtn) _existBtn.disabled = false; });
      }, 800);
    }
  }

  // +TT кнопка (початковий стан — green)
  {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-btn';
    btn.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
    btn.textContent = '+TT';
    btn.addEventListener('click', async e => { e.stopPropagation(); e.preventDefault(); await _doTtClick(); });
    wrap.appendChild(btn);
  }
}

// ── Кнопка в правій панелі ─────────────────────────────────
// ── Знайти панель кандидата (звичайний DOM) ──────────────
function findCandidatePanel() {
  // Орієнтуємось від контактних даних — вони точно в панелі кандидата, а не у навігації вакансії
  const contactEl = document.querySelector(
    'a[href^="tel:"], a[href^="mailto:"], span.tw-text-h4, span[class*="tw-text-h4"]'
  );
  if (contactEl) {
    let el = contactEl;
    for (let i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el || el.tagName === 'BODY') break;
      const cls = (typeof el.className === 'string') ? el.className : '';
      if (cls.includes('tw-grow') || cls.includes('tw-flex-1') || cls.includes('tw-overflow-y')) return el;
      if (['SECTION', 'ARTICLE', 'ASIDE'].includes(el.tagName)) return el;
    }
    // 5 рівнів вгору як fallback
    let res = contactEl;
    for (let i = 0; i < 5; i++) res = res?.parentElement || res;
    return res;
  }
  // Fallback до старого підходу якщо контактів ще немає
  const heading = document.querySelector('[class*="tw-text-h3"], [class*="tw-text-h2"]');
  if (!heading) return null;
  return heading.closest('[class*="tw-grow"], [class*="tw-flex-1"], section, article')
    || heading.parentElement;
}

// Знайти посилання для завантаження резюме.
// scope — обмежений контейнер (відкрита панель кандидата) щоб не підхопити чужий файл.
// Якщо scope не задано — шукаємо по всьому документу (для /resumes/{id} сторінок).
function findResumeLink(scope) {
  const root = scope || document;
  const selectors = [
    'a[href*="resumedownload"]',
    'a[href*="/resumes/"][href*="download"]',
    'a[href*="/cv/"][href*="download"]',
    'a[href*="resume"][href*="download"]',
    'a[href*="/applicant/"][href*="download"]',
    'a[href*="/applicants/"][href*="download"]',
    'a[download]',
  ];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el?.href?.startsWith('http')) return el;
  }
  for (const a of root.querySelectorAll('a[href]')) {
    if (!a.href?.startsWith('http')) continue;
    const t = a.textContent.trim().toLowerCase();
    const h = a.href.toLowerCase();
    if ((t.includes('завантажити') || t.includes('скачати')) &&
        (h.includes('download') || h.includes('pdf') || h.includes('/cv') || h.includes('resume') || h.includes('applicant'))) {
      return a;
    }
    if ((t.includes('резюме') || t.includes('cv')) && (h.includes('download') || h.includes('pdf'))) {
      return a;
    }
  }
  return null;
}

function addDetailPanelButton(candidateId) {
  document.querySelector('.tt-detail-btn')?.remove();

  const btn = document.createElement('button');
  btn.type = 'button'; // КРИТИЧНО: без type="button" браузер надсилає форму і оновлює сторінку
  btn.className = 'tt-btn tt-detail-btn';
  btn.style.cssText = 'margin:0 8px;font-size:11px;padding:4px 12px;display:inline-block;vertical-align:middle;';
  btn.textContent = '+ Додати в Teamtailor';
  btn.addEventListener('click', async () => {
    const detail = extractFromDetailPanel();

    // Доповнюємо даними з API-кешу (responseCache заповнюється preloadResponses).
    // DOM-скрапінг часто дає лише базові поля; item.text / item.cover — повний текст.
    const apiItem = lookupResponseData(candidateId);
    if (apiItem) {
      const apiDetail = apiItemToDetail(apiItem);
      // API resumeText завжди пріоритетніше за DOM-скрапінг:
      // item.text/item.cover — надійне джерело (кандидат написав сам).
      // DOM може підхопити UI-мітки («Невідповідний тип зайнятості» тощо).
      detail.resumeText = apiDetail.resumeText || detail.resumeText || '';
      if (!detail.phone     && apiDetail.phone)      detail.phone      = apiDetail.phone;
      if (!detail.email     && apiDetail.email)       detail.email      = apiDetail.email;
      if (!detail.picture   && apiDetail.picture)     detail.picture    = apiDetail.picture;
      if (!detail.withFile  && apiDetail.withFile)    detail.withFile   = apiDetail.withFile;
      if (!detail.responseId && apiDetail.responseId) detail.responseId = apiDetail.responseId;
      if (!detail.jobId     && apiDetail.jobId)       detail.jobId      = apiDetail.jobId;
    }
    // Також перевіряємо detailCache на вже збагачені дані
    if (!detail.resumeText) {
      const dc = detailCache.get(candidateId);
      if (dc?.resumeText) detail.resumeText = dc.resumeText;
    }

    // ── Для /resumes/{id}/ сторінок: дані через work.ua API ──────────────────
    // preloadResponses() покриває лише відгуки на вакансії; пряма сторінка резюме
    // не потрапляє в responseCache → завантажуємо деталі окремим запитом.
    const _isResumePage = /^\/resumes\/\d+/.test(location.pathname);
    let _apiResumeData = null;
    if (_isResumePage) {
      try {
        const rdResp = await bgMsg({ type: 'GET_WORK_RESUME_DETAIL', resumeId: candidateId });
        if (rdResp?.ok && rdResp?.data) {
          _apiResumeData = rdResp.data?.data || rdResp.data;
          const _rdd = apiItemToDetail(_apiResumeData);
          if (!detail.phone      && _rdd.phone)      detail.phone      = _rdd.phone;
          if (!detail.email      && _rdd.email)      detail.email      = _rdd.email;
          if (!detail.picture    && _rdd.picture)    detail.picture    = _rdd.picture;
          if (!detail.resumeUrl  && _rdd.resumeUrl)  detail.resumeUrl  = _rdd.resumeUrl;
          if (!detail.firstName  && _rdd.firstName)  detail.firstName  = _rdd.firstName;
          if (!detail.lastName   && _rdd.lastName)   detail.lastName   = _rdd.lastName;
          if (!detail.resumeText && _rdd.resumeText) detail.resumeText = _rdd.resumeText;
        }
      } catch (_) {}
    }

    // На /resumes/{id} шукаємо в усьому документі (вся сторінка = один кандидат).
    // На applicants-сторінках — в activePanel (щоб не захопити чужий файл зі списку).
    const _resumeScope = _isResumePage ? null : (document.querySelector('.tt-candidate-panel') || null);
    const resumeUrl = detail.resumeUrl || findResumeLink(_resumeScope)?.href || detailCache.get(candidateId)?.resumeUrl || '';
    const cached = checkCache.get(candidateId);
    if (candidateId) detailCache.set(candidateId, { ...detail, resumeUrl });

    // ── Ім'я: API → кеш → DOM ───────────────────────────────────────────────
    // Порядок пріоритету:
    // 1. API (GET_WORK_RESUME_DETAIL): fio / first_name / last_name — найнадійніше
    // 2. checkCache (processCard з відгуків/списків) — надійне для applicants-сторінок
    // 3. DOM — якщо перші два порожні
    //
    // ВАЖЛИВО: checkCache може містити "Українська" якщо scanResumeSearchCards
    // обробила великий контейнер на /resumes/{id}/ і extractFromCard знайшла
    // мовний перемикач замість h1. Тому для /resumes/ сторінок API-дані завжди першими.
    let _fn = '';
    let _ln = '';

    // Крок 1: API work.ua /resumes/{id} — ім'я з fio або окремих полів
    if (_isResumePage && _apiResumeData) {
      const rd = _apiResumeData;
      const fio = rd.fio || rd.full_name || rd.fullName || '';
      if (fio) {
        const fioPs = fio.trim().split(/\s+/).filter(Boolean);
        if (fioPs.length >= 2) { _ln = fioPs[0]; _fn = fioPs[1]; }
        else if (fioPs[0] && _looksLikeSurname(fioPs[0])) { _ln = fioPs[0]; }
        else if (fioPs[0]) { _fn = fioPs[0]; }
      }
      if (!_fn && rd.first_name) _fn = String(rd.first_name).trim();
      if (!_ln && rd.last_name)  _ln = String(rd.last_name).trim();
    }

    // Крок 2: checkCache (для applicants-сторінок де processCard вже запускався)
    if (!_fn && !_ln) {
      _fn = cached?.info?.firstName || '';
      _ln = cached?.info?.lastName  || '';
    }

    // Крок 3: DOM — окремі querySelectorAll за пріоритетом
    // Одним querySelectorAll('h1, [class*="tw-text-h2"]') НЕ можна — браузер
    // повертає в порядку документа, а не пріоритету селекторів.
    // Якщо tw-text-h2 "Українська" стоїть у DOM ДО h1 "Євген" — він буде першим!
    if (!_fn && !_ln) {
      const _SKIP_NAME_RE = /^(Українська|Русский|English|Польська|Угорська|Чеська|Увійти|Вийти|Головна|Меню|Пошук|Знайти|Відгуки|Вакансії|Компанія|Профіль|Підписка|Тарифи|Послуги|Резюме)$/i;
      const _findNameEl = (sel) => {
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest('nav, header, footer, [role="navigation"], [role="banner"]')) continue;
          const _t = (el.textContent || '').trim().split('\n')[0].trim().replace(/,.*$/, '').trim();
          if (!_t || _t.length < 2 || _t.length > 80) continue;
          if (_SKIP_NAME_RE.test(_t)) continue;
          if (!/^[А-ЯҐЄІЇA-Z]/.test(_t)) continue;
          if (/\d/.test(_t)) continue;
          return el;
        }
        return null;
      };
      const _ne = _findNameEl('h1')
               || _findNameEl('[class*="tw-text-h1"]')
               || _findNameEl('[class*="tw-text-h2"]')
               || _findNameEl('h2');
      if (_ne) {
        const _raw = (_ne.textContent || '').trim().replace(/,.*$/, '').split('\n')[0].trim();
        if (_raw && !/\d/.test(_raw)) {
          const _ps = _raw.split(/\s+/).filter(Boolean).slice(0, 3);
          if (_ps.length >= 2) { _ln = _ps[0]; _fn = _ps[1]; }
          else if (_ps[0] && _looksLikeSurname(_ps[0])) { _ln = _ps[0]; }
          else if (_ps[0]) { _fn = _ps[0]; }
        }
      }
    }

    const importInfo = {
      // DOM-заголовок як база; кеш перезаписує якщо є точніші дані
      firstName: _fn,
      lastName:  _ln,
      ...(cached?.info || {}),
      ...detail,
      resumeUrl,
      candidateId,
      workUrl: location.href,
      source: 'work.ua',
      ttData: cached?.ttData || null
    };
    const cachedStatus = cached?.status || 'green';

    // ── Перевірка дублів перед відкриттям модалки ──────────
    let knownDupe = (cachedStatus === 'orange' || cachedStatus === 'red') ? cached?.ttData : null;
    if (!knownDupe && (detail.phone || detail.email)) {
      try {
        const dupeResp = await bgMsg({
          type:  'CHECK_DUPLICATE',
          phone: detail.phone || '',
          email: detail.email || '',
          name:  `${importInfo.firstName || ''} ${importInfo.lastName || ''}`.trim()
        });
        if (dupeResp?.dupe) {
          knownDupe = dupeResp.dupe;
          // Оновлюємо бейдж у списку одразу — щоб user бачив червоний навіть якщо
          // watchDetailPanel ще не встиг оновити (race condition при швидкому кліку)
          const _c = checkCache.get(candidateId);
          persistWorkDupe(candidateId, 'red', knownDupe);
          checkCache.set(candidateId, { ...(_c || {}), status: 'red', ttData: knownDupe });
          const _listDot = document.querySelector(`#candidate-${CSS.escape(candidateId)} .tt-dot`);
          if (_listDot) { _listDot.className = 'tt-dot red'; _listDot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;'; }
        }
      } catch (_) {}
    }

    if (knownDupe) {
      openDupePopup(
        knownDupe,
        importInfo,
        () => openImportModal(importInfo, cachedStatus),         // «Все одно додати»
        (result) => {                                             // «Оновити профіль»
          const cId = result?.candidateId || '';
          if (cId && candidateId) {
            const newTtData = {
              id:    cId,
              name:  `${importInfo.firstName || ''} ${importInfo.lastName || ''}`.trim(),
              url:   result.url || `https://app.teamtailor.com/candidates/${cId}`,
              email: detail.email || '',
              phone: detail.phone || ''
            };
            checkCache.set(candidateId, { status: 'red', ttData: newTtData, info: importInfo });
          }
        }
      );
    } else {
      openImportModal(importInfo, cachedStatus);
    }
  });

  // ── Вставка кнопки ─────────────────────────────────────────────────────────
  // Стратегія A (/resumes/ сторінки): поруч з кнопкою "Запропонувати вакансію"
  // Це вже є зоною дій → наша кнопка органічно вписується і не розриває info-блок.
  const _isResumePg = /\/resumes\/\d+/.test(location.pathname);
  if (_isResumePg) {
    const _vacBtn = [...document.querySelectorAll('a, button')].find(
      el => !el.closest('nav, header') && (el.textContent || '').trim().startsWith('Запропонувати')
    );
    if (_vacBtn?.parentElement) {
      _vacBtn.parentElement.insertBefore(btn, _vacBtn.nextSibling);
      return; // вставлено ✓
    }
  }

  // Стратегія Б (applicants + fallback для resumes): inline після заголовку кандидата
  // tw-text-h2/h3 — employer portal (Tailwind); h1/h2/h3 — public resume pages
  let _insertHeading = document.querySelector('[class*="tw-text-h2"], [class*="tw-text-h3"]');

  // Fallback: перший h2/h1/h3 поза nav/header що починається з великої літери (ім'я або посада)
  if (!_insertHeading) {
    for (const el of document.querySelectorAll('h2, h1, h3')) {
      if (el.closest('nav, header, [role="navigation"]')) continue;
      const _t = el.textContent?.trim() || '';
      if (_t.length > 1 && /^[А-ЯҐЄІЇA-Za-z]/.test(_t)) { _insertHeading = el; break; }
    }
  }

  if (_insertHeading?.parentElement) {
    _insertHeading.parentElement.insertBefore(btn, _insertHeading.nextSibling);
  } else {
    // Останній варіант: вставляємо на початок основного контенту
    // (textarea "Додати коментар" або перший <main>/<article>)
    const _anchor = document.querySelector('textarea[placeholder], main, article');
    if (_anchor?.parentElement) {
      _anchor.parentElement.insertBefore(btn, _anchor);
    } else {
      // Якщо нічого не знайдено — floating фіксована кнопка
      btn.style.cssText += 'position:fixed;bottom:80px;right:20px;z-index:99999;font-size:12px;padding:8px 16px;';
      document.body.appendChild(btn);
    }
  }

  // ── Авто-імпорт для bulk-навігації ──────────────────────
  if (_bulkAutoState) {
    const _bs = _bulkAutoState;
    const _item = _bs.queue[_bs.current];
    if (_item && String(_item.id) === String(candidateId)) {
      setTimeout(() => _runBulkNavItem(_bs), 300);
    }
  }
}

function watchDetailPanel() {
  let lastCandidateId = null;

  const observer = new MutationObserver(() => {
    // Підтримуємо всі типи сторінок: відгуки (/applicants/{id}), відповіді (/responses/{id}), резюме (/resumes/{id})
    const urlMatch = location.href.match(/\/applicants\/(\d+)/)
                  || location.href.match(/\/responses\/(\d+)/)
                  || location.href.match(/\/resumes\/(\d+)/);
    const candidateId = urlMatch ? urlMatch[1] : null;
    if (!candidateId) return;

    // Кешуємо контакти + resumeUrl як тільки з'явились
    const panel = findCandidatePanel();
    if (panel && candidateId) {
      const detail = extractFromDetailPanel();
      // Передаємо panel як scope щоб не підхопити download-лінк ІНШОГО кандидата на сторінці
      const resumeUrl = findResumeLink(panel)?.href || '';
      // Доповнюємо з API-кешу — resumeText з API завжди надійніший за DOM
      // (DOM може підхопити UI-мітки на зразок «Невідповідний тип зайнятості»)
      const apiItem = lookupResponseData(candidateId);
      if (apiItem) {
        const apiDetail = apiItemToDetail(apiItem);
        // API resumeText замінює DOM-скрапінг навіть якщо DOM дав щось
        detail.resumeText = apiDetail.resumeText || detail.resumeText || '';
        if (!detail.withFile   && apiDetail.withFile)   detail.withFile   = apiDetail.withFile;
        if (!detail.responseId && apiDetail.responseId) detail.responseId = apiDetail.responseId;
        if (!detail.jobId      && apiDetail.jobId)      detail.jobId      = apiDetail.jobId;
      }
      if (detail.phone || detail.email || resumeUrl || detail.resumeText) {
        detailCache.set(candidateId, { ...detail, resumeUrl });
      }

      // ── _pendingAutoImport: захоплюємо ДО async-операцій (уникаємо race condition) ──
      // Якщо +TT натиснуто зі списку → click handler встановив _pendingAutoImport і повернув.
      // Коли профіль завантажився і watchDetailPanel спрацював — обробляємо тут.
      const _pending = _pendingAutoImport?.candidateId === candidateId ? _pendingAutoImport : null;
      if (_pending) _pendingAutoImport = null; // споживаємо одразу щоб не спрацювало двічі

      // ── Пріоритетний re-check: реальні контакти з'явились → перевіряємо без семафору ──
      // Під час bulk-навігації (_bulkAutoState) пропускаємо дубль-чек —
      // він конкурує за rate limit з IMPORT_CANDIDATE і викликає 429 cascading.
      if ((detail.phone || detail.email) && !_workDupeRecheckDone.has(candidateId) && !_bulkAutoState) {
        const _cachedBadge = checkCache.get(candidateId);
        if (!_cachedBadge || _cachedBadge.status === 'green') {
          _workDupeRecheckDone.add(candidateId);

          const _card   = document.querySelector(`#candidate-${CSS.escape(candidateId)}`);
          const _wrap   = _card?.querySelector('.tt-badge-wrap');
          const _dot    = _wrap?.querySelector('.tt-dot');
          const _tip    = _wrap?.querySelector('.tt-tooltip');
          const _detBtn = document.querySelector('.tt-detail-btn');
          if (_dot) { _dot.className = 'tt-dot orange'; }
          if (_tip) { _tip.textContent = '⏳ Перевіряю...'; }
          if (_detBtn) { _detBtn.disabled = true; _detBtn.textContent = '⏳ Перевіряю...'; }

          bgMsg({
            type:  'PANEL_CHECK_DUPLICATE',
            phone: detail.phone || '',
            email: detail.email || '',
            name:  `${_cachedBadge?.info?.firstName || ''} ${_cachedBadge?.info?.lastName || ''}`.trim()
          }).then(resp => {
            const _btn2 = document.querySelector('.tt-detail-btn');
            if (_btn2 && _btn2.disabled) {
              _btn2.disabled = false;
              _btn2.textContent = '+ Додати в Teamtailor';
            }

            if (!resp?.dupe) {
              if (_dot) { _dot.className = 'tt-dot green'; }
              if (_tip) { _tip.textContent = '✅ Немає в Teamtailor'; }
              if (_pending) {
                const _resumeUrl = detail.resumeUrl || findResumeLink(findCandidatePanel())?.href || '';
                openImportModal({ ..._pending.info, ...detail, resumeUrl: _resumeUrl, workUrl: location.href }, 'green');
              }
              return;
            }
            const _ttDupe = resp.dupe;
            persistWorkDupe(candidateId, 'red', _ttDupe);
            checkCache.set(candidateId, { ..._cachedBadge, status: 'red', ttData: _ttDupe });
            const _card2 = document.querySelector(`#candidate-${CSS.escape(candidateId)}`);
            const _wrap2 = _card2?.querySelector('.tt-badge-wrap');
            if (_wrap2) {
              const _dot2     = _wrap2.querySelector('.tt-dot');
              const _tooltip2 = _wrap2.querySelector('.tt-tooltip');
              if (_dot2) { _dot2.className = 'tt-dot red'; _dot2.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;'; }
              if (_tooltip2) _setTooltipDupe(_tooltip2, '🔴', 'Є в TT', _ttDupe.url, _ttDupe.name);
              _wrap2.querySelectorAll('.tt-btn').forEach(b => b.remove());
              if (_ttDupe.url) {
                const _lnk = document.createElement('a');
                _lnk.href = _ttDupe.url; _lnk.target = '_blank'; _lnk.className = 'tt-btn';
                _lnk.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;text-decoration:none;';
                _lnk.textContent = '↗ TT';
                _lnk.addEventListener('click', e => e.stopPropagation());
                _wrap2.appendChild(_lnk);
              }
            }
            if (_pending) {
              const _resumeUrl = detail.resumeUrl || findResumeLink(findCandidatePanel())?.href || '';
              const _mergedInfo = { ..._pending.info, ...detail, resumeUrl: _resumeUrl, workUrl: location.href, ttData: _ttDupe };
              openDupePopup(
                _ttDupe, _mergedInfo,
                () => openImportModal(_mergedInfo, 'green'),
                (result) => {
                  const _cId = result?.candidateId || '';
                  if (_cId && candidateId) {
                    const _newTt = { id: _cId, name: `${_mergedInfo.firstName} ${_mergedInfo.lastName}`.trim(),
                                     url: result.url || `https://app.teamtailor.com/candidates/${_cId}`,
                                     email: detail.email || '', phone: detail.phone || '' };
                    persistWorkDupe(candidateId, 'red', _newTt);
                    checkCache.set(candidateId, { status: 'red', ttData: _newTt, info: _pending.info });
                  }
                }
              );
            }
          }).catch(() => {});
        }
      } else if (_pending) {
        // Телефон/email не знайдені — відкриваємо модалку з тим що є (контакти порожні)
        const _resumeUrl = detail.resumeUrl || findResumeLink(findCandidatePanel())?.href || '';
        openImportModal({ ..._pending.info, ...detail, resumeUrl: _resumeUrl, workUrl: location.href }, 'green');
      }
    }

    // Додаємо кнопку якщо змінився кандидат або кнопки немає
    if (candidateId !== lastCandidateId || !document.querySelector('.tt-detail-btn')) {
      lastCandidateId = candidateId;
      setTimeout(() => addDetailPanelButton(candidateId), 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Progress bar ───────────────────────────────────────────
function createProgressBar(total) {
  const bar = document.createElement('div');
  bar.className = 'tt-bulk-bar';
  bar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2d3436;color:#fff;padding:16px 24px;border-radius:12px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.3);min-width:300px;';
  bar.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">⏳ Імпортую кандидатів...</div>
    <div style="background:#555;border-radius:4px;height:6px;overflow:hidden;">
      <div id="tt-progress-fill" style="background:#e84b3c;height:100%;width:0%;transition:width 0.3s;border-radius:4px;"></div>
    </div>
    <div id="tt-progress-text" style="font-size:11px;color:#b2bec3;margin-top:6px;">0 з ${total}</div>
  `;
  document.body.appendChild(bar);
  return {
    bar,
    update(current, name) {
      const pct  = Math.round((current / total) * 100);
      const fill = bar.querySelector('#tt-progress-fill');
      const text = bar.querySelector('#tt-progress-text');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = `${current} з ${total}${name ? ` — ${name}` : ''}`;
    },
    done(count) {
      bar.innerHTML = `<div style="font-size:13px;font-weight:600;">✅ Імпортовано ${count} кандидатів!</div>`;
      setTimeout(() => bar.remove(), 3000);
    }
  };
}

// ── Bulk bar ───────────────────────────────────────────────
let bulkBar = null;

function updateBulkBar() {
  if (selected.size === 0) { bulkBar?.remove(); bulkBar = null; return; }
  if (!bulkBar) { bulkBar = document.createElement('div'); bulkBar.className = 'tt-bulk-bar'; document.body.appendChild(bulkBar); }
  bulkBar.innerHTML = '';

  const count = document.createElement('span');
  count.innerHTML = `<span class="tt-bulk-count">${selected.size}</span> вибрано`;
  bulkBar.appendChild(count);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tt-btn';
  btn.textContent = `Імпортувати ${selected.size} в Teamtailor`;
  btn.addEventListener('click', bulkImport);
  bulkBar.appendChild(btn);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.style.cssText = 'background:#555;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;';
  clear.textContent = '✕';
  clear.addEventListener('click', () => {
    selected.clear();
    document.querySelectorAll('.tt-checkbox.checked').forEach(el => el.classList.remove('checked'));
    updateBulkBar();
  });
  bulkBar.appendChild(clear);
}

// ── Діалог вибору під час пакетного імпорту (знайдено дубль) ──
// Призупиняє цикл і повертає Promise<'skip'|'update'|'remove'>.
// НЕ закривається кліком поза — юзер мусить явно обрати дію.
function askBulkDupeChoice(candidateName, ttData) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'tt-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'tt-modal';
    modal.style.maxWidth = '420px';

    const ttUrl  = ttData?.url  || '';
    const ttName = ttData?.name || candidateName;

    modal.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;">' +
        '<h2 style="color:#e17055;margin:0;">⚠️ Кандидат вже є в Teamtailor</h2>' +
        '<button id="tt-bd-x" title="Скасувати імпорт" style="background:none;border:none;cursor:pointer;font-size:20px;color:#b2bec3;line-height:1;padding:0 2px;flex-shrink:0;margin-top:-2px;">✕</button>' +
      '</div>' +
      '<p style="font-size:13px;color:#555;margin:0 0 12px;">' +
        '<strong>' + _htmlEsc(candidateName) + '</strong> збігається з кандидатом у базі.' +
      '</p>' +
      '<div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:10px 14px;margin-bottom:16px;">' +
        '<div style="font-weight:600;font-size:13px;">' + _htmlEsc(ttName) + '</div>' +
        (ttUrl ? '<a href="' + _ttSafeUrl(ttUrl) + '" target="_blank" style="color:#0984e3;font-size:12px;text-decoration:none;">Відкрити профіль в Teamtailor ↗</a>' : '') +
        (ttData?.email ? '<div style="font-size:12px;color:#666;margin-top:4px;">✉️ ' + _htmlEsc(ttData.email) + '</div>' : '') +
        (ttData?.phone ? '<div style="font-size:12px;color:#666;margin-top:3px;">📞 ' + _htmlEsc(ttData.phone) + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<button id="tt-bd-update" class="tt-btn" style="background:#6c5ce7;justify-content:center;width:100%;">♻️ Оновити наявний профіль</button>' +
        '<button id="tt-bd-skip"   class="tt-btn" style="background:#636e72;justify-content:center;width:100%;">⏭ Пропустити</button>' +
        '<button id="tt-bd-remove" class="tt-btn-cancel" style="text-align:center;width:100%;">🗑 Видалити зі списку на імпорт</button>' +
        '<button id="tt-bd-cancel" class="tt-btn-cancel" style="text-align:center;width:100%;color:#d63031;border-color:#fab1a0;">🚫 Скасувати весь імпорт</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('#tt-bd-x'     ).addEventListener('click', () => { overlay.remove(); resolve('cancel'); });
    modal.querySelector('#tt-bd-update').addEventListener('click', () => { overlay.remove(); resolve('update'); });
    modal.querySelector('#tt-bd-skip'  ).addEventListener('click', () => { overlay.remove(); resolve('skip');   });
    modal.querySelector('#tt-bd-remove').addEventListener('click', () => { overlay.remove(); resolve('remove'); });
    modal.querySelector('#tt-bd-cancel').addEventListener('click', () => { overlay.remove(); resolve('cancel'); });
  });
}

// ── Toast після імпорту ────────────────────────────────────
// candidates = [{ name: string, url: string }, ...]
// Показується після успішного імпорту (одного або пакетного).
// Кнопки: "Відкрити всі профілі" (нові вкладки), "Переглянути пізніше" (мінімізація), "Закрити".
function showImportToast(candidates) {
  if (!candidates?.length) return;

  document.getElementById('tt-import-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'tt-import-toast';
  toast.style.cssText =
    'position:fixed;bottom:20px;right:20px;background:#1a1a2e;color:#fff;' +
    'border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5);z-index:2147483647;' +
    'min-width:280px;max-width:380px;font-family:system-ui,sans-serif;font-size:13px;overflow:hidden;';

  const n = candidates.length;
  const suffix = n === 1 ? 'а' : n < 5 ? 'и' : 'ів';
  const listItems = candidates.map(c =>
    '<li style="margin:4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
    '<a href="' + _ttSafeUrl(c.url) + '" target="_blank" style="color:#74b9ff;text-decoration:none;">' +
    _htmlEsc(c.name || 'Без імені') + '</a></li>'
  ).join('');

  toast.innerHTML =
    '<div style="background:#0984e3;padding:10px 14px;display:flex;align-items:center;gap:8px;">' +
      '<span style="font-weight:700;flex:1;">✅ Імпортовано ' + n + ' кандидат' + suffix + '</span>' +
      '<button id="tt-toast-min" title="Переглянути пізніше" ' +
        'style="background:none;border:none;color:#fff;cursor:pointer;font-size:15px;padding:0 4px;line-height:1;">—</button>' +
      '<button id="tt-toast-x" title="Закрити" ' +
        'style="background:none;border:none;color:#fff;cursor:pointer;font-size:18px;padding:0 2px;line-height:1;">✕</button>' +
    '</div>' +
    '<div id="tt-toast-body" style="padding:10px 14px;">' +
      '<ul style="margin:0 0 10px;padding-left:18px;">' + listItems + '</ul>' +
      '<div style="display:flex;gap:8px;">' +
        '<button id="tt-toast-open" ' +
          'style="flex:1;background:#0984e3;color:#fff;border:none;border-radius:6px;' +
          'padding:6px 8px;cursor:pointer;font-size:12px;font-weight:600;">🔗 Відкрити всі профілі</button>' +
        '<button id="tt-toast-close" ' +
          'style="flex:1;background:#636e72;color:#fff;border:none;border-radius:6px;' +
          'padding:6px 8px;cursor:pointer;font-size:12px;">Закрити</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(toast);

  const bodyEl = toast.querySelector('#tt-toast-body');
  const minBtn  = toast.querySelector('#tt-toast-min');
  minBtn.addEventListener('click', () => {
    const collapsed = bodyEl.style.display === 'none';
    bodyEl.style.display = collapsed ? '' : 'none';
    minBtn.textContent   = collapsed ? '—' : '▲';
  });

  const close = () => toast.remove();
  toast.querySelector('#tt-toast-x').addEventListener('click', close);
  toast.querySelector('#tt-toast-close').addEventListener('click', close);

  toast.querySelector('#tt-toast-open').addEventListener('click', () => {
    bgMsg({ type: 'OPEN_TT_TABS', urls: candidates.map(c => c.url) }).catch(() => {});
    close();
  });
}

// ── Bulk навігаційний авто-імпорт ──────────────────────────
// Виконується коли addDetailPanelButton викликається в рамках bulk-навігації.
// Імпортує поточного кандидата без модалки, потім переходить до наступного.
const _bulkRunningIds = new Set(); // guard: не запускати повторно для одного й того ж кандидата

async function _runBulkNavItem(bs) {
  const item = bs.queue[bs.current];
  if (!item) return;

  // Guard проти multiple fires: MutationObserver + re-check .tt-detail-btn можуть
  // запустити _runBulkNavItem кілька разів для одного кандидата → дублі в TT.
  const _runKey = String(item.id);
  if (_bulkRunningIds.has(_runKey)) return;
  _bulkRunningIds.add(_runKey);

  try {
    bs.progress.update(bs.current, `${item.info?.firstName || ''} ${item.info?.lastName || ''}`);

    // Чекаємо появи контактів у DOM (max 6с).
    // work.ua employer portal: span.tw-text-h4 (без tel:/mailto: посилань).
    const _bDeadline = Date.now() + 6000;
    while (Date.now() < _bDeadline) {
      if (document.querySelector('span.tw-text-h4, span[class*="tw-text-h4"], a[href^="tel:"], a[href^="mailto:"]')) break;
      await sleep(200);
    }

    let detail = extractFromDetailPanel();
    const apiItem = lookupResponseData(item.id);
    if (apiItem) {
      const apiDetail = apiItemToDetail(apiItem);
      detail.phone      = detail.phone      || apiDetail.phone;
      detail.email      = detail.email      || apiDetail.email;
      detail.picture    = detail.picture    || apiDetail.picture;
      detail.resumeText = apiDetail.resumeText || detail.resumeText || '';
      detail.withFile   = detail.withFile   || apiDetail.withFile;
      detail.responseId = detail.responseId || apiDetail.responseId;
      detail.jobId      = detail.jobId      || apiDetail.jobId;
    }
    const _dc = detailCache.get(item.id) || {};
    detail.phone = detail.phone || _dc.phone;
    detail.email = detail.email || _dc.email;

    let cached = checkCache.get(item.id);
    // Якщо статус невідомий і є контакти — перевіряємо дублі перед імпортом.
    // (PANEL_CHECK_DUPLICATE пропускається під час bulk → тут виконуємо вручну.)
    if (!cached && (detail.phone || detail.email)) {
      try {
        const _dupeResp = await bgMsg({
          type: 'CHECK_DUPLICATE',
          phone: detail.phone || '', email: detail.email || '',
          name: `${item.info?.firstName || ''} ${item.info?.lastName || ''}`.trim()
        });
        if (_dupeResp?.dupe) {
          cached = { status: 'red', ttData: _dupeResp.dupe, info: item.info };
          checkCache.set(item.id, cached);
          persistWorkDupe(item.id, 'red', _dupeResp.dupe);
        } else {
          cached = { status: 'green', ttData: null, info: item.info };
          checkCache.set(item.id, cached);
          persistWorkDupe(item.id, 'green', null);
        }
      } catch (_) {}
    }

    // Якщо дубль — показуємо діалог вибору (як у fallback-режимі)
    const _cname = `${item.info?.firstName || ''} ${item.info?.lastName || ''}`.trim();
    let _doBulkAction = 'import';
    if ((cached?.status === 'red' || cached?.status === 'orange') && cached?.ttData?.id) {
      bs.progress.update(bs.current, '⚠️ Дубль — очікую вибір');
      const _choice = await askBulkDupeChoice(_cname, cached.ttData);
      if (_choice === 'cancel') { _bulkAutoState = null; return; }
      if (_choice === 'skip') {
        _doBulkAction = 'skip';
      } else if (_choice === 'remove') {
        _doBulkAction = 'skip';
        selected.delete(item.id);
        chrome.storage.local.remove(_workDupeKey(item.id));
        checkCache.delete(item.id);
        document.querySelector(`#candidate-${CSS.escape(String(item.id))} .tt-checkbox`)?.classList.remove('checked');
      } else { // 'update'
        _doBulkAction = 'update';
      }
    }

    const tags   = item.tags;
    const effectiveResumeUrl = (detail.resumeUrl && /^https?:\/\/(?:www\.)?work\.ua\//i.test(detail.resumeUrl))
      ? '' : (detail.resumeUrl || '');

    if (_doBulkAction !== 'skip') {
      try {
        let resp;
        if (_doBulkAction === 'update') {
          resp = await bgMsg({ type: 'UPDATE_CANDIDATE', ttId: cached.ttData.id,
            candidate: { ...item.info, ...detail, source: 'work.ua', workUrl: item.info?.href || '' } });
        } else {
          resp = await bgMsg({ type: 'IMPORT_CANDIDATE',
            candidate: { ...item.info, ...detail, resumeUrl: effectiveResumeUrl, source: 'work.ua', workUrl: item.info?.href || '', tags } });
        }
        const _name = _cname;
        bs.importedCandidates.push({ name: _name, url: resp?.result?.url || '' });
        const _eid = CSS.escape(String(item.id));
        const _dot = document.querySelector(`#candidate-${_eid} .tt-dot`);
        if (_dot) { _dot.className = 'tt-dot red'; const _tt = _dot.querySelector('.tt-tooltip'); if (_tt) _tt.textContent = '🔴 Імпортовано в TT'; }
        document.querySelector(`#candidate-${_eid} .tt-btn`)?.remove();
        document.querySelector(`#candidate-${_eid} .tt-checkbox`)?.classList.remove('checked');
        selected.delete(item.id);
      } catch (_) {}
    }

    bs.current++;
    const nextItem = bs.queue[bs.current];
    if (nextItem) {
      const _nId = CSS.escape(String(nextItem.id));
      const nextLink = document.querySelector(
        `#candidate-${_nId} a[href*="/applicants/"], #candidate-${_nId} a[href*="/responses/"]`
      );
      if (nextLink) {
        nextLink.click();
      } else if (nextItem.href) {
        location.href = nextItem.href;
      } else {
        // Fallback: будуємо URL з поточного шаблону
        const _base = location.href.match(/(.*\/(?:applicants|responses)\/)\d+/)?.[1];
        if (_base) location.href = _base + nextItem.id + '/';
      }
    } else {
      _bulkAutoState = null;
      bs.progress.update(bs.queue.length, '✅ Готово');
      setTimeout(() => document.querySelector('.tt-bulk-bar')?.remove(), 3000);
      showImportToast(bs.importedCandidates); // ← було showBulkToast (не існувало)
    }
  } finally {
    _bulkRunningIds.delete(_runKey);
  }
}

// ── Bulk import ────────────────────────────────────────────
async function bulkImport() {
  const ids  = [...selected];
  bulkBar?.remove(); bulkBar = null;

  const tags     = ['work.ua', ...(prefs.recruiter_tag ? [prefs.recruiter_tag] : [])];

  // ── Навігаційний режим (якщо є /applicants/ посилання) ──
  // Для кожного кандидата відкриваємо його профіль щоб гарантовано отримати
  // phone/email/резюме, а не покладатись на неповні дані зі списку.
  const _firstId = ids[0];
  const _firstLink = _firstId
    ? document.querySelector(`#candidate-${CSS.escape(String(_firstId))} a[href*="/applicants/"]`)
    : null;
  if (_firstLink) {
    const progress = createProgressBar(ids.length);
    const queue = ids.map(id => {
      const cached = checkCache.get(id);
      return { id, href: cached?.info?.href || '', tags, info: cached?.info || {} };
    });
    _bulkAutoState = { queue, current: 0, progress, importedCandidates: [] };

    // Якщо вже на профілі першого кандидата — URL не зміниться,
    // watchDetailPanel не спрацює → тригеруємо _runBulkNavItem напряму.
    const _curUrlId = location.href.match(/\/applicants\/(\d+)/)?.[1]
                   || location.href.match(/\/responses\/(\d+)/)?.[1];
    if (_curUrlId && String(_curUrlId) === String(_firstId)) {
      setTimeout(() => _runBulkNavItem(_bulkAutoState), 300);
    } else {
      _firstLink.click();
    }
    return;
  }

  // ── Fallback: без навігації (для /resumes/ та інших сторінок без /applicants/ посилань) ──
  const progress = createProgressBar(ids.length);
  let   count    = 0;
  const importedCandidates = []; // для toast після імпорту

  for (let i = 0; i < ids.length; i++) {
    const id     = ids[i];
    const cached = checkCache.get(id);
    if (!cached) continue;

    const name = `${cached.info.firstName} ${cached.info.lastName}`.trim();
    progress.update(i, name);

    let detail = detailCache.get(id) || {};

    // ── Крок 1: збагачення з API-кешу ───────────────────────
    // Робимо це ЗАВЖДИ — навіть якщо phone/email вже є в detail:
    // кешований detail міг бути записаний до того як API-кеш заповнився.
    const apiItem = lookupResponseData(id);
    if (apiItem) {
      const apiDetail = apiItemToDetail(apiItem);
      if (!detail.phone)      detail.phone      = apiDetail.phone;
      if (!detail.email)      detail.email      = apiDetail.email;
      if (!detail.picture)    detail.picture    = apiDetail.picture;
      if (!detail.withFile)   detail.withFile   = apiDetail.withFile;
      if (!detail.jobId)      detail.jobId      = apiDetail.jobId;
      if (!detail.responseId) detail.responseId = apiDetail.responseId;
      // API resumeText (item.text + item.cover) завжди надійніший за DOM-скрапінг
      detail.resumeText = apiDetail.resumeText || detail.resumeText || '';
      detailCache.set(id, detail);
    }

    // ── Крок 2: DOM-fallback якщо контактів все ще немає ───
    if (!detail.phone && !detail.email) {
      const fresh = await clickCardAndWait(id);
      if (fresh) {
        if (!detail.phone)   detail.phone   = fresh.phone;
        if (!detail.email)   detail.email   = fresh.email;
        if (!detail.picture) detail.picture = fresh.picture;
        // DOM не оновлює resumeText — він ненадійний (API вже заповнив або залишаємо порожнім)
        detailCache.set(id, detail);
      }
    }

    // ── Перевірка дублів перед імпортом ─────────────────────
    // Якщо бейдж вже червоний/помаранчевий — кандидат є в TT; пропонуємо вибір.
    let bulkAction = 'import';
    if ((cached?.status === 'red' || cached?.status === 'orange') && cached?.ttData?.id) {
      progress.update(i, '⚠️ Дубль — очікую вибір');
      const choice = await askBulkDupeChoice(name, cached.ttData);
      if (choice === 'cancel') break;
      if (choice === 'skip') continue;
      if (choice === 'remove') {
        selected.delete(id);
        const _reid = CSS.escape(String(id));
        document.querySelector(`#candidate-${_reid} .tt-checkbox`)?.classList.remove('checked');
        continue;
      }
      bulkAction = 'update'; // choice === 'update'
    }

    try {
      // Очищаємо пряме www.work.ua посилання — TT не може завантажити файл звідти.
      // Зберігаємо лише transient:/ URI (якщо юзер вже натиснув ⬇️ у модалці раніше).
      const effectiveResumeUrl = (detail.resumeUrl && /^https?:\/\/(?:www\.)?work\.ua\//i.test(detail.resumeUrl))
        ? '' : (detail.resumeUrl || '');

      let resp;
      if (bulkAction === 'update') {
        resp = await bgMsg({
          type:      'UPDATE_CANDIDATE',
          ttId:      cached.ttData.id,
          candidate: { ...cached.info, ...detail, source: 'work.ua', workUrl: cached.info.href }
        });
      } else {
        resp = await bgMsg({
          type: 'IMPORT_CANDIDATE',
          candidate: { ...cached.info, ...detail, resumeUrl: effectiveResumeUrl, source: 'work.ua', workUrl: cached.info.href, tags }
        });
      }
      const _eid = CSS.escape(String(id));
      const dot = document.querySelector(`#candidate-${_eid} .tt-dot`);
      if (dot) {
        dot.className = 'tt-dot red';
        dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
        const tt = dot.querySelector('.tt-tooltip');
        if (tt) tt.textContent = '🔴 Імпортовано в TT';
      }
      // Оновлюємо checkCache щоб наступний processCard не скинув бейдж на зелений
      if (checkCache.has(id)) {
        const _wc = checkCache.get(id);
        checkCache.set(id, { ..._wc, status: 'red' });
      }
      document.querySelector(`#candidate-${_eid} .tt-btn`)?.remove();
      document.querySelector(`#candidate-${_eid} .tt-checkbox`)?.classList.remove('checked');
      if (resp?.result?.url) importedCandidates.push({ name, url: resp.result.url });
      count++;
    } catch (e) {}

    progress.update(i + 1, name);
    await sleep(1200); // пауза між кандидатами — уникаємо 429 від TT API
  }

  selected.clear();
  document.querySelectorAll('.tt-checkbox.checked').forEach(el => el.classList.remove('checked'));
  progress.bar.remove();
  showImportToast(importedCandidates);
  if (!importedCandidates.length) {
    // Fallback: якщо TT не повернув URL або всі провалились
    const doneEl = document.createElement('div');
    doneEl.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#00b894;color:#fff;padding:10px 24px;border-radius:10px;font-size:13px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    doneEl.textContent = `✅ Імпортовано ${count} з ${ids.length} кандидатів`;
    document.body.appendChild(doneEl);
    setTimeout(() => doneEl.remove(), 3500);
  }
}

// ── Вспливаюче вікно "Кандидат вже є в TT" ────────────────
function openDupePopup(existingTT, enriched, onAddAnyway, onUpdateDone) {
  const overlay = document.createElement('div');
  overlay.className = 'tt-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'tt-modal';
  modal.style.cssText = 'max-width:440px;';

  const byLabels = { phone: 'телефоном', email: 'e-mail', name: 'іменем' };
  const byLabel  = byLabels[existingTT.matchedBy] || existingTT.matchedBy || 'даними';
  const candName = `${enriched.firstName || ''} ${enriched.lastName || ''}`.trim()
                || enriched.fullName || '';
  const ttName   = existingTT.name || candName;

  // BUG-04/19: екрануємо всі дані кандидата перед вставкою у innerHTML
  modal.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;">
      <h2 style="color:#e17055;margin:0;">⚠️ Кандидат вже є в Teamtailor</h2>
      <button id="tt-dp-x" title="Закрити" style="background:none;border:none;cursor:pointer;font-size:20px;color:#b2bec3;line-height:1;padding:0 2px;flex-shrink:0;margin-top:-2px;">✕</button>
    </div>
    <p style="margin:0 0 12px;font-size:13px;color:#555;">
      <strong>${_htmlEsc(candName)}</strong> збігається з кандидатом у базі за
      <strong>${_htmlEsc(byLabel)}</strong>.
    </p>
    <div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px;">${_htmlEsc(ttName)}</div>
      <a id="tt-dupe-link" href="${_ttSafeUrl(existingTT.url)}" target="_blank"
         style="color:#0984e3;font-size:12px;text-decoration:none;">
        Відкрити профіль в Teamtailor ↗
      </a>
      ${existingTT.email ? `<div style="font-size:12px;color:#666;margin-top:5px;">✉️ ${_htmlEsc(existingTT.email)}</div>` : ''}
      ${existingTT.phone ? `<div style="font-size:12px;color:#666;margin-top:3px;">📞 ${_htmlEsc(existingTT.phone)}</div>` : ''}
    </div>
    <div class="tt-modal-actions" style="flex-direction:column;gap:8px;">
      <button class="tt-btn" id="tt-dp-update"
              style="width:100%;background:#6c5ce7;justify-content:center;">
        ♻️ Оновити наявний профіль
      </button>
      <button class="tt-btn" id="tt-dp-add"
              style="width:100%;background:#e17055;justify-content:center;">
        ➕ Все одно додати як нового
      </button>
      <button class="tt-btn-cancel" id="tt-dp-cancel"
              style="width:100%;text-align:center;">
        Скасувати
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector('#tt-dp-x').addEventListener('click', () => overlay.remove());
  modal.querySelector('#tt-dp-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  modal.querySelector('#tt-dp-add').addEventListener('click', () => {
    overlay.remove();
    if (typeof onAddAnyway === 'function') onAddAnyway();
  });

  modal.querySelector('#tt-dp-update').addEventListener('click', async () => {
    const btn = modal.querySelector('#tt-dp-update');
    btn.textContent = '⏳ Оновлюю...';
    btn.disabled = true;
    try {
      const resp = await bgMsg({
        type:      'UPDATE_CANDIDATE',
        ttId:      existingTT.id,
        candidate: {
          ...enriched,
          source:  'work.ua',
          workUrl: enriched.href || location.href
        }
      });
      if (resp?.ok) {
        btn.textContent = '✅ Профіль оновлено!';
        btn.style.background = '#00b894';
        if (typeof onUpdateDone === 'function') onUpdateDone(resp.result);
        showImportToast([{ name: candName || ttName, url: resp.result?.url || existingTT.url || '' }]);
        setTimeout(() => overlay.remove(), 1500);
      } else {
        btn.textContent = '❌ ' + (resp?.error || 'Помилка оновлення').substring(0, 60);
        btn.disabled = false;
      }
    } catch (e) {
      btn.textContent = '❌ Помилка';
      btn.disabled = false;
    }
  });
}

// ── Import modal ───────────────────────────────────────────
function openImportModal(info, status) {
  const overlay = document.createElement('div');
  overlay.className = 'tt-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'tt-modal';

  const initTags    = ['work.ua', ...(prefs.recruiter_tag ? [prefs.recruiter_tag] : [])];
  const displayName = `${info.firstName || ''} ${info.lastName || ''}`.trim() || info.fullName || '';

  // BUG-04/19: попередньо екрануємо всі поля що будуть у innerHTML
  const _eFn   = _htmlEsc(info.firstName  || '');
  const _eLn   = _htmlEsc(info.lastName   || '');
  const _ePh   = _htmlEsc(info.phone      || '');
  const _eEm   = _htmlEsc(info.email      || '');
  const _eName = _htmlEsc(displayName);
  const _eCid  = _htmlEsc(String(info.candidateId || ''));
  const _ePic  = _safePic(info.picture);

  const dupeHtml = (status === 'red' || status === 'orange') && info.ttData?.url
    ? `<div style="background:${status==='red'?'#ffe3e0':'#fff8e1'};border:1.5px solid ${status==='red'?'#e74c3c':'#f39c12'};border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:${status==='red'?'#c0392b':'#e67e22'};">
        ${status==='red'?'🔴 Вже є в Teamtailor':'🟠 Є в TT, дані різняться'} — <a href="${_ttSafeUrl(info.ttData.url)}" target="_blank" style="font-weight:700;color:inherit;">відкрити профіль ↗</a>
       </div>`
    : '';

  // Текст резюме показуємо у textarea ЛИШЕ якщо файл НЕ завантажено.
  // Якщо файл є — cover-letter не буде встановлено; textarea лише заплутає.
  const hasFileAlready = !!(info.ttResumeUrl && info.ttResumeUrl.trim());
  const resumeSnippet = (info.resumeText && !hasFileAlready)
    ? `<div class="tt-field"><label>Текст резюме (Lettera di presentazione)</label><textarea id="tt-resume-text" style="height:120px;font-size:11px;">${info.resumeText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea></div>`
    : '';

  modal.innerHTML = `
    <h2>🚀 Імпорт в Teamtailor</h2>
    ${dupeHtml}
    <div class="tt-candidate-preview">
      ${_ePic
        ? `<img src="${_ePic}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`
        : `<div class="tt-avatar-placeholder">${_htmlEsc((info.firstName?.[0] || info.lastName?.[0] || '?').toUpperCase())}</div>`}
      <div class="tt-preview-info">
        <div class="tt-preview-name">${_eName}</div>
        <div class="tt-preview-meta">work.ua · ID ${_eCid}</div>
      </div>
    </div>
    <div class="tt-field"><label>Ім'я</label><input id="tt-fn" value="${_eFn}"></div>
    <div class="tt-field"><label>Прізвище</label><input id="tt-ln" value="${_eLn}"></div>
    <div class="tt-field"><label>Телефон</label><input id="tt-phone" value="${_ePh}" placeholder="+380..."></div>
    <div class="tt-field"><label>Email</label><input id="tt-email" value="${_eEm}" placeholder="email@..."></div>
    <div class="tt-field" id="tt-resume-btns">
      ${info.resumeUrl ? `<a href="${_safePic(info.resumeUrl)}" target="_blank" class="tt-resume-link" style="margin-right:8px;">👁 Переглянути резюме</a>` : ''}
      ${info.withFile && info.jobId && info.responseId ? `<button class="tt-resume-link" id="tt-dl-resume" style="cursor:pointer;border:none;">⬇️ Завантажити в Teamtailor</button>` : ''}
      ${info.href ? `<a href="${_safePic(info.href)}" target="_blank" class="tt-resume-link">📄 Профіль на work.ua</a>` : ''}
    </div>
    ${resumeSnippet}
    <div class="tt-field"><label>Вакансія</label><select id="tt-job"><option value="">— без вакансії —</option></select></div>
    <div class="tt-field"><label>Локація</label><select id="tt-loc"><option value="">— без локації —</option></select></div>
    <div class="tt-field"><label>Відділ</label><select id="tt-dept"><option value="">— без відділу —</option></select></div>
    <div class="tt-field"><label>Роль</label><select id="tt-role"><option value="">— без ролі —</option></select></div>
    <div class="tt-field"><label>Теги</label><div class="tt-tags-wrap" id="tt-tags"></div></div>
    <div class="tt-field"><label>Коментар</label><textarea id="tt-comment" placeholder="Коментар..."></textarea></div>
    <div class="tt-modal-actions">
      <button class="tt-btn-cancel" id="tt-cancel">Скасувати</button>
      <button class="tt-btn" id="tt-confirm">✓ Імпортувати</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Кнопка завантаження файлу відгуку через браузерну сесію work.ua (підтримує 2FA)
  const dlBtn = modal.querySelector('#tt-dl-resume');
  if (dlBtn && info.jobId && info.responseId) {
    dlBtn.addEventListener('click', async () => {
      dlBtn.textContent = '⏳ Завантажую...';
      dlBtn.disabled = true;
      try {
        // ── Стратегія завантаження ──────────────────────────────────────────────
        // MV3 content script НЕ може cross-origin fetch (CORS блокує api.work.ua).
        // Але www.work.ua/resumedownload/... — це same-origin → fetch без CORS, сесія автоматична.
        // Якщо DOM URL відсутній — делегуємо до background.js (Basic Auth fallback).
        const domUrl = (info.resumeUrl && /^https:\/\/(?:www\.)?work\.ua\//i.test(info.resumeUrl))
          ? info.resumeUrl : null;

        let base64, mimeType, fileName;

        if (domUrl) {
          // ── Same-origin fetch (www.work.ua) ────────────────────────────────
          console.log('[TT work.js] ⬇️ Fetching resume via DOM URL (same-origin):', domUrl);
          const r = await fetch(domUrl, { credentials: 'include' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);

          // Тип: з Content-Type, або з розширення URL (www.work.ua часто повертає octet-stream)
          const rawMime  = (r.headers.get('content-type') || '').split(';')[0].trim();
          const urlExt   = domUrl.split('?')[0].split('.').pop().toLowerCase();
          const extMimes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', rtf: 'application/rtf', txt: 'text/plain' };
          mimeType = (rawMime && rawMime !== 'application/octet-stream') ? rawMime : (extMimes[urlExt] || 'application/pdf');

          const mimeExts = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc', 'application/rtf': 'rtf', 'text/plain': 'txt' };
          const ext = mimeExts[mimeType] || urlExt || 'pdf';

          // Назва файлу: Content-Disposition → URL filename → формуємо
          const cd      = r.headers.get('content-disposition') || '';
          const cdMatch = cd.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
          const origName = cdMatch ? decodeURIComponent(cdMatch[1].replace(/"/g, '').trim()) : '';
          const urlFile  = domUrl.split('/').pop().split('?')[0];
          fileName = origName
            || (urlFile && urlFile.includes('.') ? decodeURIComponent(urlFile) : '')
            || `resume_${info.firstName || ''}_${info.lastName || ''}.${ext}`.replace(/\s+/g, '_');

          console.log('[TT work.js] ⬇️ DOM fetch OK | mime:', mimeType, '| file:', fileName);

          // ArrayBuffer → base64 (чанками щоб уникнути переповнення стеку)
          const ab    = await r.arrayBuffer();
          const uint8 = new Uint8Array(ab);
          const CHUNK = 8192;
          let binary  = '';
          for (let i = 0; i < uint8.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
          }
          base64 = btoa(binary);
          console.log('[TT work.js] ⬇️ base64 len:', base64.length, '→ uploading to TT...');

        } else {
          // ── Fallback: background.js (Basic Auth) ────────────────────────────
          // Спрацьовує якщо DOM URL не знайдено; може не працювати з 2FA
          console.log('[TT work.js] ⬇️ No DOM URL — delegating to background.js');
          const bgR = await bgMsg({
            type:       'WORK_DOWNLOAD_RESUME',
            jobId:      String(info.jobId      || ''),
            responseId: String(info.responseId || ''),
            resumeId:   String(info.candidateId || ''),   // fallback для /resumes/{id} сторінок
            candidateId: String(info.candidateId || ''),
            fileName:   `resume_${info.firstName || ''}_${info.lastName || ''}.pdf`.replace(/\s+/g, '_')
          });
          if (bgR?.ok && bgR?.url) {
            // background handler вже завантажив у TT — зберігаємо URL і виходимо
            dlBtn.textContent = '✅ Завантажено';
            info.ttResumeUrl = bgR.url;
            const link = document.createElement('a');
            link.href = bgR.url; link.target = '_blank';
            link.className = 'tt-resume-link'; link.style.marginLeft = '8px';
            link.textContent = '🔗 Відкрити';
            dlBtn.parentElement.appendChild(link);
            return;   // вже готово — виходимо з try-блоку
          }
          throw new Error('Відкрийте профіль кандидата і спробуйте ще раз');
        }

        // Завантажуємо у TT через background (POST /v1/files) — лише для DOM URL path
        const resp = await bgMsg({
          type:     'WORK_UPLOAD_RESUME_BASE64',
          base64,
          mimeType,
          fileName
        });

        if (resp?.ok && resp?.url) {
          dlBtn.textContent = '✅ Завантажено';
          info.ttResumeUrl = resp.url;  // transient:/ URI від TT → піде у PATCH при імпорті
          // Ховаємо обидва textarea (cover-letter + resumeBody) — файл завантажено
          modal.querySelector('#tt-resume-text')?.closest('.tt-field')?.style.setProperty('display','none');
          modal.querySelectorAll('.tt-field textarea[readonly]').forEach(t => t.closest('.tt-field').style.display = 'none');
          const link = document.createElement('a');
          link.href = resp.url; link.target = '_blank';
          link.className = 'tt-resume-link'; link.style.marginLeft = '8px';
          link.textContent = '🔗 Відкрити';
          dlBtn.parentElement.appendChild(link);
        } else {
          throw new Error(resp?.error || 'TT upload failed');
        }
      } catch(e) {
        console.warn('[TT work.js] Resume download/upload failed:', e);
        dlBtn.textContent = '❌ Помилка';
        dlBtn.disabled = false;
      }
    });
  }

  // Завантажуємо prefs свіжо + списки TT паралельно
  Promise.all([
    bgMsg({ type: 'GET_TT_LISTS' }),
    new Promise(r => chrome.storage.local.get(null, r))
  ]).then(([resp, freshPrefs]) => {
    if (!resp?.ok) return;
    const fill = (selId, items, attrKey, defId) => {
      const sel = modal.querySelector(selId);
      if (!sel) return;
      (items || []).forEach(i => {
        const label = i.attributes?.[attrKey] || i.attributes?.name || 'Без назви';
        const o = new Option(label, i.id);
        if (defId && String(i.id) === String(defId)) o.selected = true;
        sel.appendChild(o);
      });
    };
    fill('#tt-job',  resp.jobs,  'internal-name', freshPrefs.default_job_id);
    fill('#tt-loc',  resp.locs,  'name',          freshPrefs.default_loc_id);
    fill('#tt-dept', resp.depts, 'name',          freshPrefs.default_dept_id);
    fill('#tt-role', resp.roles, 'name',          freshPrefs.default_role_id);
  }).catch(() => {});

  const tagsWrap = modal.querySelector('#tt-tags');
  const selectedTags = new Set(initTags);
  let allAvailableTagsW = [...FIXED_TAGS.filter(t => t !== 'robota.ua' && t !== 'work.ua')];

  const _renderTagsUIW = () => {
    tagsWrap.innerHTML = '';
    const chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;';
    selectedTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tt-tag selected';
      chip.textContent = tag;
      chip.dataset.tag = tag;
      chip.addEventListener('click', () => { selectedTags.delete(tag); _renderTagsUIW(); });
      chipsWrap.appendChild(chip);
    });
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'position:relative;display:inline-block;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Змінити ▾';
    btn.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:10px;border:1.5px solid #dfe6e9;background:#f0f2f5;color:#2d3436;cursor:pointer;white-space:nowrap;';
    const dropdown = document.createElement('div');
    dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:9999;background:#fff;border:1.5px solid #e84b3c;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.13);min-width:200px;max-height:220px;overflow-y:auto;padding:4px;';
    const _fillDropdownW = () => {
      dropdown.innerHTML = '';
      allAvailableTagsW.forEach(tag => {
        const item = document.createElement('div');
        item.textContent = tag;
        const isSel = selectedTags.has(tag);
        item.style.cssText = `padding:6px 10px;font-size:12px;cursor:pointer;border-radius:5px;background:${isSel ? '#e84b3c' : ''};color:${isSel ? '#fff' : '#2d3436'};`;
        item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = '#f0f2f5'; });
        item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          isSel ? selectedTags.delete(tag) : selectedTags.add(tag);
          dropdown.style.display = 'none';
          _renderTagsUIW();
        });
        dropdown.appendChild(item);
      });
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      dropdown.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) _fillDropdownW();
    });
    document.addEventListener('click', () => { dropdown.style.display = 'none'; }, { once: false });
    btnWrap.appendChild(btn);
    btnWrap.appendChild(dropdown);
    chipsWrap.appendChild(btnWrap);
    tagsWrap.appendChild(chipsWrap);
  };

  _renderTagsUIW();

  bgMsg({ type: 'GET_TT_TAGS' }).then(resp => {
    if (!resp?.tags?.length) return;
    const fixedSet = new Set(allAvailableTagsW.map(t => t.toLowerCase()));
    const skipTags = new Set(['robota.ua', 'work.ua']);
    for (const tag of resp.tags) {
      if (!skipTags.has(tag.toLowerCase()) && !fixedSet.has(tag.toLowerCase())) {
        allAvailableTagsW.push(tag);
      }
    }
  }).catch(() => {});

  modal.querySelector('#tt-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  modal.querySelector('#tt-confirm').addEventListener('click', async () => {
    const confirmBtn = modal.querySelector('#tt-confirm');
    confirmBtn.textContent = '⏳ Імпортую...';
    confirmBtn.className   = 'tt-btn loading';
    confirmBtn.disabled    = true;

    const c = {
      firstName:  modal.querySelector('#tt-fn').value.trim()  || info.firstName,
      lastName:   modal.querySelector('#tt-ln').value.trim()  || info.lastName,
      phone:      modal.querySelector('#tt-phone').value.trim(),
      email:      modal.querySelector('#tt-email').value.trim(),
      picture:    info.picture,
      jobId:      modal.querySelector('#tt-job').value,
      locationId: modal.querySelector('#tt-loc').value,
      deptId:     modal.querySelector('#tt-dept').value,
      roleId:     modal.querySelector('#tt-role').value,
      comment:    modal.querySelector('#tt-comment').value.trim(),
      resumeText: modal.querySelector('#tt-resume-text')?.value.trim() || info.resumeText || '',
      resumeUrl:  info.ttResumeUrl || '',  // TT transient URI (лише якщо юзер натиснув ⬇️)
      tags:       [...selectedTags],
      source:     'work.ua',
      workUrl:    info.href || location.href,
      sourceUrl:  location.href,
      // Work.ua-специфічні поля для backend-mapping та авто-завантаження резюме
      candidateId: info.candidateId  || '',  // для backendSaveMapping('work:{id}')
      responseId:  info.responseId   || '',  // для GET /response_files/{jobId}/{responseId}
      withFile:    info.withFile     || false // для _shouldAutoDownloadWork в importCandidate
    };

    const resp = await bgMsg({ type: 'IMPORT_CANDIDATE', candidate: c });
    if (resp?.ok) {
      confirmBtn.textContent = '✅ Додано!';
      confirmBtn.className   = 'tt-btn success';

      // ── Зберігаємо red статус після імпорту — наступний перегляд без TT API ──
      if (info.candidateId && resp.result?.url) {
        const _ttW = {
          id:   String(resp.result?.candidateId || resp.result?.url?.split('/').pop() || ''),
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          url:  resp.result.url
        };
        persistWorkDupe(info.candidateId, 'red', _ttW);
        checkCache.set(info.candidateId, { status: 'red', ttData: _ttW, info: { ...info } });
      }

      if (info.candidateId) {
        const _ceid = CSS.escape(String(info.candidateId));
        const dot = document.querySelector(`#candidate-${_ceid} .tt-dot`);
        if (dot) {
          dot.className = 'tt-dot red';
          dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
          const tt = dot.querySelector('.tt-tooltip');
          if (tt) tt.innerHTML = `🔴 Є в TT — <a href="${_ttSafeUrl(resp.result?.url)}" target="_blank">Відкрити</a>`;
        }
        document.querySelector(`#candidate-${_ceid} .tt-btn`)?.remove();
      }
      const _toastName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || info.fullName || '';
      showImportToast([{ name: _toastName, url: resp.result?.url || '' }]);
      setTimeout(() => overlay.remove(), 1500);
    } else {
      confirmBtn.textContent = '❌ Помилка';
      confirmBtn.textContent = '❌ ' + (resp?.error || 'Помилка').substring(0, 60);
      confirmBtn.className   = 'tt-btn';
      confirmBtn.disabled    = false;
    }
  });
}

// ── Scan resume search cards (work.ua/resumes*) ─────────────
// На сторінці пошуку резюме картки не мають id="candidate-*",
// тому шукаємо за посиланнями /resumes/{id}/ і беремо батьківський контейнер
function scanResumeSearchCards() {
  const seen = new Set();
  document.querySelectorAll('a[href*="/resumes/"]:not([href*="download"])').forEach(link => {
    const id = link.href.match(/\/resumes\/(\d+)/)?.[1] || '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    // Шукаємо найближчий блок-контейнер (article або div із достатньою висотою)
    let card = link.closest('article, [class*="card"], [class*="resume-item"], li');
    if (!card) {
      // fallback: йдемо вгору до першого достатньо великого блоку
      card = link.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!card || card === document.body) break;
        const r = card.getBoundingClientRect();
        if (r.height > 70 && r.width > 300) break;
        card = card.parentElement;
      }
    }
    if (!card || card === document.body || card.dataset.ttProcessed) return;
    // Чекаємо поки span.strong-600 відрендериться (SPA lazy render).
    // Якщо його немає — пропускаємо; MutationObserver повторить сканування при наступному DOM-update.
    if (!card.querySelector('span.strong-600')) return;
    processCard(card);
  });
}

// ── Observer ───────────────────────────────────────────────
function observeCards() {
  // scanResumeSearchCards — лише для сторінок-списків резюме (/resumes*, /resumes-*),
  // але НЕ на окремій сторінці /resumes/{id}/ (там тільки addDetailPanelButton).
  // На /resumes/{id}/ scanResumeSearchCards знаходить великий контейнер-сторінку і
  // processCard → extractFromCard підхоплює мовний перемикач "Українська" замість h1 кандидата.
  const isResumeListPage = /\/resumes/.test(location.pathname)
                        && !/^\/resumes\/\d+/.test(location.pathname);
  const scanAll = () => {
    document.querySelectorAll('div[id^="candidate-"]').forEach(card => {
      if (!card.dataset.ttProcessed) processCard(card);
    });
    if (isResumeListPage) scanResumeSearchCards();
  };
  // Дебаунс 150ms: зменшує кількість зайвих викликів під час швидких DOM-мутацій
  let _workScanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(_workScanTimer);
    _workScanTimer = setTimeout(scanAll, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Backend batch pre-check ────────────────────────────────
async function preloadFromBackend() {
  try {
    const cards = [...document.querySelectorAll('div[id^="candidate-"]')];
    const ids   = [];
    const idMap = new Map(); // backendKey → candidateId
    for (const card of cards) {
      const cid = card.id?.replace('candidate-', '') || '';
      if (!cid) continue;
      const key = `work:${cid}`;
      ids.push(key);
      idMap.set(key, cid);
    }
    if (!ids.length) return;

    const resp = await bgMsg({ type: 'BACKEND_BATCH_CHECK', ids });
    if (!resp?.ok || !resp?.result) return;

    for (const [backendKey, ttData] of Object.entries(resp.result)) {
      const candidateId = idMap.get(backendKey);
      if (!candidateId || !ttData?.ttId) continue;
      const ttEntry = { id: ttData.ttId, name: ttData.ttName || '', url: ttData.ttUrl || '' };
      checkCache.set(candidateId, { status: 'red', ttData: ttEntry, info: { candidateId } });
      persistWorkDupe(candidateId, 'red', ttEntry);
    }
    const found = Object.keys(resp.result).length;
    if (found) console.log(`[TT] backend batch (work): ${found}/${ids.length} знайдено`);
  } catch (_) {}
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  await loadPrefs();

  // Backend batch-check — чекаємо до 500ms (backend ~30ms).
  // Без await processCard стартує раніше ніж checkCache заповнений.
  await Promise.race([preloadFromBackend(), new Promise(r => setTimeout(r, 500))]);

  // Preload виконуємо СПОЧАТКУ щоб responseCache був заповнений до processCard.
  // Це гарантує що badge-check отримає телефон/email із кешу (без зайвих API-викликів).
  await preloadResponses();

  document.querySelectorAll('div[id^="candidate-"]').forEach(card => {
    if (!card.dataset.ttProcessed) processCard(card);
  });
  // Скануємо картки лише на сторінках-списках резюме, НЕ на /resumes/{id}/ (окреме резюме)
  if (/\/resumes/.test(location.pathname) && !/^\/resumes\/\d+/.test(location.pathname)) {
    scanResumeSearchCards();
  }
  observeCards();
  watchDetailPanel();

  // Пряме відкриття сторінки окремого резюме (/resumes/{id}/) —
  // watchDetailPanel чекає на DOM-мутації, але React може вже відрендерити DOM.
  // Додаємо кнопку напряму; якщо вона ще є — не перезаписуємо.
  const _singleResumeId = location.pathname.match(/^\/resumes\/(\d+)/)?.[1];
  if (_singleResumeId) {
    setTimeout(() => {
      if (!document.querySelector('.tt-detail-btn')) addDetailPanelButton(_singleResumeId);
    }, 1500);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
