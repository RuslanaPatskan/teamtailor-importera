// ============================================================
// Teamtailor Importera — content/robota.js v3.16
// robota.ua/my/vacancies/*/candidates
// ============================================================

const FIXED_TAGS = [
  'robota.ua',
  'alexandra (recruiter)', 'alexandra (recruiter/sourcer)',
  'anastasiia (recruiter)', 'daniela (recruiter)', 'daryna (recruiter)', 'daryna (sourcer)',
  'julia (sourcer)', 'maria (recruiter)', 'maryna (recruiter/sourcer)', 'oleksandra (sourcer)',
  'ruslana (recruiter)', 'serhii (recruiter)', 'sofia (recruiter)',
  'valentyna (sourcer)', 'victoriia (sourcer)'
];

let prefs              = {};
let selected           = new Set();
let checkCache         = new Map(); // cardId → { status, ttData, info }
let applyCache         = new Map(); // applyId / resumeId → apply item or full resume data
let resumeIdMap        = new Map(); // applyId (string) → resumeId (string)
let numericApplyIdMap  = new Map(); // UUID applyId → numeric applyId (for /apply/view/{id})
let nameApplyIdMap     = new Map(); // name.toLowerCase() → { numericId, item } (Interaction UUID→ID)

// ── Bulk name check (IntersectionObserver) ────────────────
const _rNameBatchPending = new Map();
let _rNameBatchTimer = null;

async function _rFireNameBatch() {
  if (!_rNameBatchPending.size) return;
  const snapshot = [..._rNameBatchPending.entries()];
  _rNameBatchPending.clear();
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

function _rQueueNameCheck(name, cardId, applyFn) {
  if (!_rNameBatchPending.has(name)) _rNameBatchPending.set(name, []);
  _rNameBatchPending.get(name).push({ cardId, applyFn });
  clearTimeout(_rNameBatchTimer);
  _rNameBatchTimer = setTimeout(_rFireNameBatch, 300);
}

const _rNameCheckObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    _rNameCheckObserver.unobserve(entry.target);
    const p = entry.target._ttNameCheck;
    if (p) { delete entry.target._ttNameCheck; _rQueueNameCheck(p.name, p.cardId, p.applyFn); }
  }
}, { rootMargin: '400px 0px' });

// ── Обробник перехоплених API-відповідей ──────────────────────────────────
// (Перехоплення fetch виконується у content/robota-spy.js, world: MAIN,
//  run_at: document_start — не блокується CSP сайту)
function ttNormalizePhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (!d) return String(p);
  if (d.startsWith('380') && d.length === 12) return '+' + d;
  if (d.startsWith('0')   && d.length === 10) return '+38' + d;
  return String(p);
}

// Повертає false для фейкових телефон-email типу "380681234567@phone-registration.rabota.ua"
function ttIsRealEmail(e) {
  if (!e) return false;
  return !String(e).toLowerCase().includes('phone-registration.rabota.ua');
}

function ttCacheApiItem(item) {
  if (!item || typeof item !== 'object') return;
  // Нормалізуємо eMail (robota.ua API) → email (стандарт)
  // Фейкові phone-registration emails відкидаємо одразу
  if (item.eMail && !item.email) item.email = item.eMail;
  if (item.email && !ttIsRealEmail(item.email)) item.email = '';
  if (item.eMail && !ttIsRealEmail(item.eMail)) item.eMail = '';
  if (item.phone) item.phone = ttNormalizePhone(item.phone);

  // Interaction / Offered кандидати: контакти зберігаються у вкладених масивах
  // (apply/list повертає contacts.phones[]/emails[] — тут витягуємо одразу,
  //  щоб early-cache return у getFullCandidateData міг повернути контакти)
  if (!item.phone && item.contacts?.phones?.length) {
    const _ph = item.contacts.phones[0]?.value
             || item.contacts.phones[0]?.phoneNumber
             || item.contacts.phones[0]?.number
             || (typeof item.contacts.phones[0] === 'string' ? item.contacts.phones[0] : '');
    if (_ph) item.phone = ttNormalizePhone(_ph);
  }
  if ((!item.email || !ttIsRealEmail(item.email)) && item.contacts?.emails?.length) {
    const _ev = item.contacts.emails[0]?.value
             || item.contacts.emails[0]?.email
             || (typeof item.contacts.emails[0] === 'string' ? item.contacts.emails[0] : '');
    if (_ev && ttIsRealEmail(_ev)) item.email = _ev;
  }

  // Primary numeric ID: applyId/id для /apply/list, resumeId для /cvdb/resumes (пошук резюме)
  const numRaw  = item.id ?? item.applyId ?? item.resumeId ?? item.resume_id ?? null;
  const numStr  = (numRaw !== null && /^\d+$/.test(String(numRaw))) ? String(numRaw) : '';
  const uuidRaw = item.interactionId ?? item.interaction_id ?? item.uid
               ?? item.uuid          ?? item.guid
               ?? item.externalId    ?? item.external_id
               ?? item.candidateUid  ?? item.candidateId    ?? '';
  // Нормалізуємо GUID: прибираємо дефіси (robota.ua URL — формат без дефісів)
  const uuidStr  = String(uuidRaw || '');
  const uuidNorm = uuidStr.replace(/-/g, '').toLowerCase(); // "a4ecf3..." без дефісів
  const uuidKey  = uuidNorm || uuidStr;                     // використовуємо нормалізований
  const isUuid   = /^[0-9a-f]{8}/i.test(uuidKey);

  // UUID → числовий applyId (потрібен для /apply/view/{id})
  if (isUuid && numStr) {
    [uuidKey, uuidStr].filter(Boolean).forEach(k => {
      if (!numericApplyIdMap.has(k)) {
        numericApplyIdMap.set(k,                   numStr);
        numericApplyIdMap.set(`${k}-interaction`,  numStr);
      }
    });
    console.log('[TT] 🔗 UUID→numericApplyId:', uuidKey.substring(0, 8) + '…', '→', numStr);
  }

  // Кешуємо item за всіма відомими ключами.
  // Якщо ключ вже є — оновлюємо тільки якщо новий запис має phone/email яких не було.
  // (preload дає базові дані; spy може пізніше прийти з контактами — оновлюємо)
  const _newHasContacts = !!(item.phone || item.email);
  const _keys = [numStr, numStr && `${numStr}-attach`,
                 uuidStr, uuidNorm, isUuid && `${uuidKey}-interaction`].filter(Boolean);
  let _contactsAdded = false;
  for (const k of _keys) {
    const _existing = applyCache.get(k);
    if (!_existing) {
      applyCache.set(k, item);
    } else if (_newHasContacts && !_existing.phone && !_existing.email) {
      // Нові дані з контактами — оновлюємо запис
      applyCache.set(k, { ..._existing, ...item });
      _contactsAdded = true;
    }
  }

  // Якщо щойно з'явились контакти — перевіряємо чи є зелені бейджі для цього кандидата
  // і одразу перезапускаємо їх без очікування preload-ре-скану
  if (_contactsAdded && _newHasContacts) {
    setTimeout(() => {
      for (const k of _keys) {
        const _cc = checkCache.get(k);
        if (_cc?.status === 'green' && !_cc._badgePhone && !_cc._badgeEmail) {
          const _card = document.querySelector(`.tt-badge-wrap[data-card-id="${CSS.escape(k)}"]`)?.closest(CARD_SELECTORS.split(',')[0].trim()) ||
                        document.querySelector(`[data-apply-id="${CSS.escape(k)}"], [data-id="${CSS.escape(k)}"]`)?.closest(CARD_SELECTORS.split(',')[0].trim());
          if (_card) {
            checkCache.delete(k);
            _card.querySelector('.tt-badge-wrap')?.remove();
            delete _card.dataset.ttProcessed;
            processCard(_card);
            console.log('[TT] ре-чек після появи контактів:', k);
          }
        }
      }
    }, 100);
  }

  // Будуємо resumeIdMap якщо є реальний resumeId
  const rId = String(item.resumeId || item.resume_id || '');
  if (rId && rId !== '0') {
    [numStr, uuidStr, uuidNorm, numStr && `${numStr}-attach`,
     isUuid && `${uuidKey}-interaction`
    ].filter(Boolean).forEach(k => { if (!resumeIdMap.has(k)) resumeIdMap.set(k, rId); });
  }

  // Будуємо nameApplyIdMap для пошуку за іменем (з DOM-картки → numericId)
  // Для /cvdb/resumes: name беремо з fullName або firstName+lastName
  const _name = String(item.name || item.fullName ||
                       (item.lastName && item.firstName ? `${item.lastName} ${item.firstName}` : '') ||
                       '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (_name && numStr && !nameApplyIdMap.has(_name)) {
    nameApplyIdMap.set(_name, { numericId: numStr, item });
  }
}

window.addEventListener('message', function(evt) {
  // BUG-20: перевіряємо origin — приймаємо лише повідомлення від robota-spy.js з того самого домену
  if (evt.origin !== location.origin) return;
  if (!evt.data || !evt.data.__ttSpy) return;
  try {
    const parsed = JSON.parse(evt.data.body);
    const url    = evt.data.url || '';
    const short  = url.split('employer-api.robota.ua').pop() || url;

    // Логуємо ВСІ URL — щоб бачити що Angular викликає для VacancyInteraction кандидатів
    console.log('[TT SPY] 📡', short);

    // 32-символьний hex без дефісів у шляху URL (напр. /apply/a4ecf361... → 'a4ecf361...')
    const _urlHexM = short.match(/\/([0-9a-f]{32})(?:[/?&#-]|$)/i);
    const _urlUuid = _urlHexM ? _urlHexM[1].toLowerCase() : '';

    // Шукаємо масив кандидатів у будь-якій відповіді
    // /apply/list:      applies/items/candidates/interactions
    // /cvdb/resumes:    documents/resumes (база резюме, employer-api.robota.ua/cvdb/resumes)
    // /resume/byresume: similar
    // /my/vacancies/all/applies та /my/candidates: list/results/pipeline/board
    const listFields = [
      parsed?.applies, parsed?.items, parsed?.candidates,
      parsed?.interactions, parsed?.interactionList, parsed?.list,
      parsed?.documents, parsed?.resumes, parsed?.results, parsed?.pipeline, parsed?.board,
      parsed?.data?.applies, parsed?.data?.items, parsed?.data?.candidates,
      parsed?.data?.interactions, parsed?.data?.list, parsed?.data?.results,
      parsed?.data?.documents, parsed?.data?.resumes,
      Array.isArray(parsed) ? parsed : null
    ];
    let list = listFields.find(x => Array.isArray(x) && x.length > 0);

    // Fallback: якщо жоден із відомих ключів не підійшов — шукаємо масив
    // де елементи схожі САМЕ на кандидата (вимагаємо специфічні candidate-поля,
    // щоб не захопити масиви вакансій/ролей/відділів де є лише id + name).
    if (!list && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed?.data || parsed;
      if (root && typeof root === 'object') {
        for (const v of Object.values(root)) {
          if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object') {
            const s = v[0];
            // Ознаки candidate-об'єкта: специфічні ID-поля АБО обидва поля імені одночасно.
            // НЕ приймаємо лише id+name — такі об'єкти можуть бути вакансіями/ролями.
            const isCandidate = !!(
              s.interactionId || s.interaction_id ||
              s.applyId       || s.apply_id       ||
              s.candidateId   || s.candidate_id   ||
              (s.firstName && s.lastName)
            );
            if (isCandidate) {
              list = v;
              console.log('[TT SPY] ⚡ Fallback:', Object.keys(root).find(k => root[k] === v), '→', v.length, 'items');
              break;
            }
          }
        }
      }
    }

    if (list) {
      list.forEach(ttCacheApiItem);
      console.log('[TT] 📡', short, '→', list.length, 'елементів (ключі:', Object.keys(parsed).join(', ') + ')');

      // ── Re-scan після даних від spy ──────────────────────────
      // На /candidates/all/* та інших сторінках без vacancyId preloadApplyList не виконується.
      // Spy заповнив applyCache → перезапускаємо картки (в т.ч. невідомих компонентів).
      if (!getVacancyId() && list.length > 0) {
        setTimeout(() => {
          let rs = 0;
          // 1. Відомі CARD_SELECTORS: оновлюємо зелені з новим ім'ям
          document.querySelectorAll(CARD_SELECTORS).forEach(card => {
            const info   = extractFromCard(card);
            const cardId = info.applyId || info.fullName;
            if (!cardId) return;
            const cached = checkCache.get(cardId);
            if (cached && cached.status === 'green') {
              const oldName = `${cached.info?.firstName || ''} ${cached.info?.lastName || ''}`.trim();
              const newName = `${info.firstName} ${info.lastName}`.trim();
              const nameChanged    = newName && newName !== oldName;
              const hadNoName      = !oldName && newName;
              const hadNoContacts  = !cached.info?.phone && !cached.info?.email;
              const nowHasContacts = !!(info.phone || info.email);
              if (nameChanged || hadNoName || (hadNoContacts && nowHasContacts)) {
                checkCache.delete(cardId);
                card.querySelector('.tt-badge-wrap')?.remove();
                delete card.dataset.ttProcessed;
                processCard(card);
                rs++;
              }
            }
          });
          // 2. Fallback-сканер для карток поза CARD_SELECTORS (/candidates/all/* тощо)
          const _isCv = /\/candidates(?:\/all)?\//i.test(location.pathname) &&
                        !/\/my\/vacancies\//i.test(location.pathname);
          if (_isCv) scanCandidateSearchCards();
          if (rs) console.log('[TT] spy re-scan (no vacancyId):', rs, 'зелених карток');
        }, 300);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      // Одиночний запис
      const item = parsed.data || parsed;
      if (typeof item === 'object' && !Array.isArray(item)) {
        ttCacheApiItem(item);

        // Додатково кешуємо під UUID з URL-шляху (UUID в тілі ≠ UUID в URL)
        if (_urlUuid && !applyCache.has(_urlUuid)) {
          applyCache.set(_urlUuid, item);
          applyCache.set(`${_urlUuid}-interaction`, item);
        }
        // Якщо тіло має числовий id — будуємо UUID→numericApplyId
        const _d = item?.data || item;
        const _numId = String(_d?.id || _d?.applyId || '');
        if (_urlUuid && _numId && /^\d+$/.test(_numId) && !numericApplyIdMap.has(_urlUuid)) {
          numericApplyIdMap.set(_urlUuid, _numId);
          numericApplyIdMap.set(`${_urlUuid}-interaction`, _numId);
          console.log('[TT SPY] URL UUID→numericId:', _urlUuid.substring(0, 8) + '…', '→', _numId);
        }

        console.log('[TT] 📡', short, '→ ключі:', Object.keys(item).slice(0, 15).join(', '));
      }
    }
  } catch(_) {}
});

async function loadPrefs() {
  return new Promise(resolve => chrome.storage.local.get(null, r => { prefs = r || {}; resolve(); }));
}

function bgMsg(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) {
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

function getVacancyId() {
  const m = location.pathname.match(/\/my\/vacancies\/(\d+)\//);
  return m ? m[1] : null;
}

// ── Завантажуємо список відгуків через API ─────────────────
let _preloadRunning         = false;
let _preloadDoneForVacancy  = ''; // вакансія, для якої preload вже успішно завершено
async function preloadApplyList() {
  if (_preloadRunning) return;
  const vacancyId = getVacancyId();

  // Підтримуємо глобальні сторінки: /my/vacancies/all/* та /my/candidates
  // На них немає vacancyId, але нам потрібен preload для коректного badge та контактів
  const isGlobalPage = !vacancyId && (
    /\/my\/vacancies\/all\//i.test(location.pathname) ||
    /\/my\/candidates/.test(location.pathname)
  );
  if (!vacancyId && !isGlobalPage) return;

  // Ключ для дедуплікації: vacancyId або pathname для глобальних сторінок
  const preloadKey = vacancyId || location.pathname.replace(/\?.*$/, '');
  // Не завантажуємо повторно якщо вже є дані для цієї вакансії.
  // Виняток: якщо в перший раз не отримали жодного елемента (ще не було токена) —
  //   тоді _preloadDoneForVacancy буде '' і 2.5-секундний retry спрацює.
  if (_preloadDoneForVacancy === preloadKey) return;
  _preloadRunning = true;
  try {
    // API повертає 20 записів на сторінку, відповідь: { total: N, applies: [...] }
    // Завантажуємо перші 5 сторінок (100 кандидатів) або до кінця якщо total відомий
    for (let page = 0; page < 5; page++) {
      const resp = await bgMsg({ type: 'GET_ROBOTA_APPLY_LIST', vacancyId: vacancyId || null, page });
      if (!resp?.ok || !resp.data) break;

      // Пріоритет: applies (офіційне поле відповіді з API 2025), потім legacy-поля
      const rd = resp.data;
      const items = rd.applies        || rd.items           || rd.candidates
                 || rd.data          || rd.results          || rd.list
                 || rd.vacancyApplies
                 || (Array.isArray(rd) ? rd : []);
      const total = rd.total ?? null; // загальна кількість (API 2025)
      console.log('[TT] preload apply/list сторінка', page, '→', items.length,
                  'елементів', total !== null ? `(total: ${total})` : '');
      if (!items.length) break;

      items.forEach(item => {
        // Нормалізуємо поля до стандартного вигляду (eMail→email, phone→+380...)
        if (item.eMail && !item.email) item.email = item.eMail;
        // Фейковий phone-registration email — відкидаємо
        if (item.email && !ttIsRealEmail(item.email)) item.email = '';
        if (item.eMail && !ttIsRealEmail(item.eMail)) item.eMail = '';
        if (item.phone) item.phone = ttNormalizePhone(item.phone);

        const rawId  = String(item.id || item.applyId || '').trim();
        // UUID з тіла відповіді (API оновлення: GUID→INT для VacancyInteraction — guid в окремому полі)
        const uuidRaw = String(
          item.interactionId || item.interaction_id ||
          item.uid           || item.uuid           ||
          item.guid          || item.externalId     ||
          item.external_id   || item.candidateUid   ||
          item.resumeGuid    || item.applyGuid       || ''
        ).trim();
        // Нормалізуємо GUID: прибираємо дефіси щоб збігалися з URL-форматом
        const uuidId   = uuidRaw.replace(/-/g, '').toLowerCase();
        const resumeId = String(item.resumeId || item.resume_id || item.ResumeId
                                             || item.cvId      || item.cv_id || '').trim();
        // Нормалізуємо resumeType: підтримуємо старі назви (AttachedFile, Notepad...)
        // і нові candidateTypes з API 2025 (ApplicationWithFile, ApplicationWithResume...).
        // API docs: GUID→INT тепер автоматичний для Interaction/Recommended/Offered.
        const _rtRaw = item.resumeType || item.resume_type || item.candidateType || '';
        const _rtMap = {
          // Старі назви
          attachedfile: 'AttachedFile', attach: 'AttachedFile', file: 'AttachedFile',
          notepad: 'Notepad', interaction: 'Interaction',
          selected: 'Selected', selectedresume: 'Selected', nocvapply: 'NoCvApply',
          vacancyoffered: 'VacancyOffered', recommended: 'Recommended',
          // Нові назви candidateTypes (API 2025)
          applicationwithfile: 'AttachedFile',
          applicationwithresume: 'Notepad',
          application: 'NoCvApply',
          vacancyinteraction: 'Interaction',
        };
        const resumeType = _rtMap[_rtRaw.toLowerCase()] || _rtRaw;

        // Збагачуємо item мета-даними для наступних звернень
        item._resumeType = resumeType;

        // ── КРИТИЧНО: встановлюємо _numericApplyId і _resumeId на item вже тут,
        // щоб early-cache return в getFullCandidateData теж мав ці поля.
        // Без цього кнопка "⬇️ Завантажити резюме" ніколи не з'являється для
        // кандидатів у яких є phone/email (вони повертаються з кешу до кінця ф-ції).
        if (/^\d+$/.test(rawId)) item._numericApplyId = rawId;
        const _preloadResumeId = (resumeId && resumeId !== '0') ? resumeId : '';
        if (_preloadResumeId) item._resumeId = _preloadResumeId;
        // Зберігаємо оригінальну назву файлу (для AttachedFile — реальне ім'я резюме)
        if (item.fileName) item._originalFileName = item.fileName;

        // resumeFile — новий тип резюме "File" (API 2025):
        // кандидат завантажив PDF/DOC у профіль (resumeType = "Notepad", але є файл).
        // Зберігаємо метадані файлу для відображення імені та завантаження.
        if (item.resumeFile) {
          item._resumeFile = item.resumeFile;
          // Ім'я файлу з resumeFile (пріоритет над item.fileName)
          const _rfName = item.resumeFile?.fileName || item.resumeFile?.name
                       || item.resumeFile?.originalName || '';
          if (_rfName && !item._originalFileName) item._originalFileName = _rfName;
        }

        // Interaction кандидати: контакти бувають у contacts.phones[]/emails[]
        // (apply/list повертає підтверджені контакти у вкладеному масиві)
        if (resumeType === 'Interaction') {
          if (!item.phone && item.contacts?.phones?.length) {
            item.phone = ttNormalizePhone(item.contacts.phones[0]?.value || '');
          }
          if ((!item.email || !ttIsRealEmail(item.email)) && item.contacts?.emails?.length) {
            const _ev = item.contacts.emails[0]?.value || '';
            if (_ev && ttIsRealEmail(_ev)) item.email = _ev;
          }
        }

        // Будуємо name → {numericId, item} для UUID→numericId маппінгу без UUID-поля в API
        const _nameKey = (item.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (_nameKey && rawId && /^\d+$/.test(rawId)) {
          nameApplyIdMap.set(_nameKey, { numericId: rawId, item });
        }

        // Визначаємо: який ідентифікатор числовий (для /apply/view/{id}), а який UUID
        const isRawNumeric  = /^\d+$/.test(rawId);
        const isUuidNumeric = /^\d+$/.test(uuidId);
        const numericId     = isRawNumeric ? rawId : (isUuidNumeric ? uuidId : '');
        const uuidKey       = !isRawNumeric ? rawId : (!isUuidNumeric ? uuidId : '');

        // Кешуємо item за всіма можливими ключами
        if (rawId)    applyCache.set(rawId, item);
        if (uuidId && uuidId !== rawId) applyCache.set(uuidId, item);
        if (uuidRaw && uuidRaw !== uuidId) applyCache.set(uuidRaw, item); // з дефісами теж
        if (resumeId && resumeId !== rawId && resumeId !== uuidId) applyCache.set(resumeId, item);
        // Також кешуємо з суфіксом -interaction (robota.ua URL-формат)
        if (uuidKey && !uuidKey.endsWith('-interaction')) {
          applyCache.set(`${uuidKey}-interaction`, item);
        }

        // Будуємо resumeIdMap: будь-яка форма applyId → resumeId
        if (resumeId) {
          [rawId, uuidId, uuidRaw].filter(Boolean).forEach(k => resumeIdMap.set(k, resumeId));
          if (uuidKey && !uuidKey.endsWith('-interaction')) {
            resumeIdMap.set(`${uuidKey}-interaction`, resumeId);
          }
        }

        // Будуємо numericApplyIdMap: UUID → числовий applyId (для /apply/view/{id})
        if (numericId && uuidKey) {
          numericApplyIdMap.set(uuidKey, numericId);
          if (!uuidKey.endsWith('-interaction')) {
            numericApplyIdMap.set(`${uuidKey}-interaction`, numericId);
          }
        }

        // Для числового rawId кешуємо з URL-суфіксами (-attach, -interaction)
        // Robota.ua передає ?id=98516070-attach — без цього кеш не знаходить запис
        if (isRawNumeric && rawId) {
          applyCache.set(`${rawId}-attach`, item);
          numericApplyIdMap.set(`${rawId}-attach`, rawId);
          if (resumeId) resumeIdMap.set(`${rawId}-attach`, resumeId);
          if (!applyCache.has(`${rawId}-interaction`)) {
            applyCache.set(`${rawId}-interaction`, item);
            numericApplyIdMap.set(`${rawId}-interaction`, rawId);
            if (resumeId) resumeIdMap.set(`${rawId}-interaction`, resumeId);
          }
        }
      });

      if (items.length < 20) break; // остання сторінка
    }
    console.log('[TT] preload завершено. nameApplyIdMap:', nameApplyIdMap.size, 'записів. Зразки:',
      [...nameApplyIdMap.keys()].slice(0, 8).map(k => JSON.stringify(k)).join(', '));
    // Завжди позначаємо preload виконаним — навіть якщо nameApplyIdMap порожній
    // (наприклад, всі кандидати анонімні). Без цього preloadApplyList запускався б
    // знову і знову на кожен debounce-цикл, генеруючи зайві API-запити.
    _preloadDoneForVacancy = preloadKey;
    if (nameApplyIdMap.size > 0) {
      // ── Перезапускаємо картки з зеленим бейджем ──────────
      // processCard міг запуститись до завершення preload (race condition):
      // applyCache ще порожній → ім'я з DOM може бути неточним → хибно-зелений результат.
      // Тепер applyCache повний → перевіряємо зелені картки ще раз.
      // Затримка 300 мс щоб Angular повністю відрендерив DOM після завантаження даних.
      setTimeout(() => {
        let rescanned = 0;
        document.querySelectorAll(CARD_SELECTORS).forEach(card => {
          const info   = extractFromCard(card); // тепер з applyCache
          const cardId = info.applyId || info.fullName;
          if (!cardId) return;
          const cached = checkCache.get(cardId);
          // Перезапускаємо якщо бейдж зелений І:
          // 1) ім'я стало точнішим після preload, АБО
          // 2) тепер є телефон/email яких раніше не було (можуть виявити дубль)
          if (cached && cached.status === 'green') {
            const oldName  = `${cached.info?.firstName || ''} ${cached.info?.lastName || ''}`.trim();
            const newName  = `${info.firstName} ${info.lastName}`.trim();
            const nameChanged = newName && newName !== oldName;
            // extractFromCard не повертає phone/email — читаємо напряму з applyCache
            const _bStrip2 = (info.applyId || '').replace(/-[a-z][a-z]*$/i, '');
            const _bCi2    = applyCache.get(info.applyId) || applyCache.get(_bStrip2);
            const _bCd2    = _bCi2?.data || _bCi2;
            const nowPhone = _bCd2?.phone || _bCd2?.contactInfo?.phone?.phoneNumber || _bCd2?.phoneNumber || '';
            const nowEmail = _bCd2?.email || _bCd2?.contactInfo?.email || _bCd2?.emailAddress || '';
            const hadNoContacts  = !cached._badgePhone && !cached._badgeEmail;
            const nowHasContacts = !!(nowPhone || nowEmail);
            if (nameChanged || (hadNoContacts && nowHasContacts)) {
              checkCache.delete(cardId);
              card.querySelector('.tt-badge-wrap')?.remove();
              delete card.dataset.ttProcessed;
              processCard(card);
              rescanned++;
            }
          }
        });
        if (rescanned) console.log('[TT] re-scan після preload:', rescanned, 'зелених карток');
      }, 300);
    }
  } catch (e) { console.error('[TT] preload помилка:', e); }
  finally { _preloadRunning = false; }
}

// Перевірка чи рядок схожий на ім'я (кириличне або латинське)
// Вимога: 2-4 слова, ВСІ починаються з ВЕЛИКОЇ літери (без /i!), є букви, немає цифр
function looksLikeName(txt) {
  if (!txt || txt.length < 4 || txt.length > 60) return false;
  const words = txt.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/\d/.test(txt)) return false;
  // Допускаємо: кирилиця АБО чисто-латинські імена (напр. "Vermiglio Valerio")
  if (!/[А-ЯҐЄІЇа-яґєіїA-Za-z]/.test(txt)) return false;
  if (!/[А-ЯҐЄІЇа-яґєії]/.test(txt) && !/^[A-Za-zÀ-ÿ'\- ]+$/.test(txt)) return false;
  // Для чисто-латинського тексту: відхиляємо типові англійські job-title слова
  // (напр. "Manager Support", "Sales Director", "Team Lead")
  if (!/[А-ЯҐЄІЇа-яґєії]/.test(txt) &&
      /^(Manager|Director|Support|Lead|Senior|Junior|Head|Chief|Officer|Engineer|Developer|Designer|Analyst|Specialist|Coordinator|Administrator|Supervisor|Executive|Representative|Associate|Assistant|Accountant|Recruiter|Consultant|Trainer|Teacher|Sales|Marketing|Finance|Technical|Commercial|Regional|General|Project|Product|Business|Operations|Strategy|Human|Resources|Customer|Service|Account|Content|Brand|Legal|Compliance)/i.test(words[0])) return false;
  // СУВОРО: кожне слово повинно починатись з ВЕЛИКОЇ літери (без /i)
  if (!words.every(w => /^[А-ЯҐЄІЇA-Z]/.test(w))) return false;
  // Відхиляємо злиті кириличні слова: після 1-го символу не може бути великої КИРИЛИЧНОЇ літери.
  // Angular рендерить <span>Яна</span><span>Київ</span> без пробілу → textContent="ЯнаКиїв".
  // Такі злиття: "ЯнаКиїв", "СергійОдеса" — відхиляємо; латинські "McDonald", "Vermiglio" — дозвіл.
  if (words.some(w => w.length > 1 && /[А-ЯҐЄІЇ]/.test(w.slice(1)))) return false;
  // Дієслівні інфінітиви (-ти, -тися, -ться): жодне справжнє ім'я так не закінчується
  // ("Завантажити", "Поскаржитися", "Роздрукувати" — UI-кнопки, не імена)
  if (words.some(w => /ти(ся)?$/i.test(w) || /ться$/i.test(w))) return false;
  // Відомі UI/статус-слова та проф. назви що з'являються як назви компаній — не можуть бути ім'ям
  if (/^(Взаємодія|Переглянутий|Відгук|Відмов|Пропозиція|Відкрив|Запрошен|Архів|Новий|Зберіг|Додав|Переглянут|Відповів|Оператор|Менеджер|Помічник|Консультант|Адміністра|Репетитор|Директор|Бухгалтер|Юрист|Психолог|Координатор|Спеціаліст|Фахівець|Технік|Аналітик|Маркетолог|Рекрутер|Тренер|Педагог|Вчитель|Логіст|Економіст|Дизайнер|Програміст|Лікар|Нотаріус|Інженер|Підприємець|Комерційний|Технічний|Регіональний|Генеральний|Головний|Старший|Молодший|Виконавчий|Фінансовий|Виробничий|Операційний|Стратегічний|ТОВ|ФОП|ПАТ|ПП|LLC|Ltd|Inc)/i.test(words[0])) return false;
  return true;
}

// ── Утиліти безпечного HTML ──────────────────────────────
// Екранує спецсимволи перед вставкою в innerHTML (захист від XSS і зламаної розмітки)
const _htmlEsc  = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Перевіряє що URL веде тільки на app.teamtailor.com (проти javascript: тощо)
const _ttSafeUrl = u => /^https:\/\/app\.teamtailor\.com\//.test(String(u || '')) ? u : '#';
// Безпечний URL для img src — дозволяємо лише http/https, екрануємо для HTML-атрибуту
const _safePic   = u => /^https?:\/\//i.test(String(u || '')) ? _htmlEsc(u) : '';

// UI/статус-слова robota.ua що можуть потрапити у DOM-текст замість імені
const _UI_WORD_RE = /^(Відгук|Взаємодія|Переглянутий|Непереглянутий|Пропозиція|Відкрив|Файл|Нотатка|Новий|Нова|Відмова|Відмовлен|Архів|Запрошен|Залишив|Переглянут|Додав|Зберіг|Відповів)$/i;

// Розбиває fullName на {lastName, firstName, patronymic} з урахуванням:
// 1. Одне слово → firstName (не lastName), бо це найчастіше ім'я без прізвища
// 2. UI-слова ("Відгук", "Взаємодія" тощо) фільтруються перед розбивкою
function parseNameParts(fullName) {
  const rawParts = (fullName || '').split(/\s+/).slice(0, 5);
  // Чистимо коми/крапки/двокрапки в кінці слів (DOM: "Тарас, Київ" → "Тарас")
  // Відкидаємо UI-слова + слова з цифрами + порожні
  const parts = rawParts
    .map(w => w.replace(/^[,.;:'"`]+|[,.;:'"`]+$/g, '').trim())
    .filter(w => w && !_UI_WORD_RE.test(w) && !/\d/.test(w))
    // Залишаємо тільки слова з ВЕЛИКОЇ літери (українські імена/прізвища)
    .filter(w => /^[А-ЯҐЄІЇA-Z]/.test(w))
    .slice(0, 3);

  // Визначення по-батькові: закінчується на -ович/-евич/-євич/-йович (чол.)
  // або -овна/-евна/-євна/-івна (жін.)
  const _isPatronymic = (w) => /(?:ович|евич|євич|йович|овна|евна|євна|івна)$/i.test(w);

  let lastName = '', firstName = '', patronymic = '';

  if (parts.length === 0) {
    // нічого
  } else if (parts.length === 1) {
    firstName = parts[0]; // одне слово → ім'я (не прізвище)
  } else if (parts.length === 2) {
    // 2 слова — спочатку перевіряємо чи є по-батькові (CVDB/приватний режим: "Ім'я По-батькові")
    const pidx2 = parts.findIndex(_isPatronymic);
    if (pidx2 === 1) {
      // "Людмила Ігорівна" / "Іван Константинович" → ім'я + по-батькові (прізвище сховано)
      firstName = parts[0]; patronymic = parts[1];
    } else if (pidx2 === 0) {
      // "Ігорівна Людмила" — незвичний порядок, але можливий
      patronymic = parts[0]; firstName = parts[1];
    } else {
      // Без по-батькові: стандартно "Прізвище Ім'я"
      lastName = parts[0]; firstName = parts[1];
    }
  } else {
    // 3 слова — шукаємо по-батькові, щоб визначити порядок
    const pidx = parts.findIndex(_isPatronymic);
    if (pidx === 1) {
      // DOM-порядок: "Ім'я По-батькові Прізвище" (robota.ua standalone, неформальний)
      firstName = parts[0]; patronymic = parts[1]; lastName = parts[2];
    } else if (pidx === 2) {
      // API-порядок: "Прізвище Ім'я По-батькові" (офіційний)
      lastName = parts[0]; firstName = parts[1]; patronymic = parts[2];
    } else {
      // Без по-батькові: стандартно перше = прізвище, друге = ім'я
      lastName = parts[0]; firstName = parts[1];
    }
    // Санітація: відхиляємо злитий рядок (Angular без пробілу: "ОлексійовичХарків")
    if (patronymic.length > 1 && /[А-ЯҐЄІЇA-Z]/.test(patronymic.slice(1))) patronymic = '';
    if (lastName.length  > 1 && /[А-ЯҐЄІЇA-Z]/.test(lastName.slice(1)))  lastName  = '';
  }

  return { lastName, firstName, patronymic };
}

// ── Витягнути дані з картки ────────────────────────────────
function extractFromCard(card) {
  let applyId      = '';
  let nameFromLink = '';

  // 1. data-* attributes on the card itself
  applyId = card.dataset.applyId || card.dataset.resumeId || card.dataset.id || '';

  // 2. data-* on nested elements
  if (!applyId) {
    const el = card.querySelector('[data-apply-id],[data-resume-id],[data-id]');
    if (el) applyId = el.dataset.applyId || el.dataset.resumeId || el.dataset.id || '';
  }

  // 3. Скануємо ВСІ посилання — ?id= (candidates) або /applies/{id} (all/applies) або /candidates/{id} (resume search)
  for (const l of card.querySelectorAll('a[href]')) {
    // Варіант A: query param ?id=... (сторінка /candidates)
    const mQ = l.href.match(/[?&](?:id|applyId|resumeId|apply_id|resume_id)=([^&\s#]+)/i);
    // Варіант B: path /applies/{id} або /apply/{id} (сторінка /all/applies)
    const mP = !mQ ? l.href.match(/\/applies?\/([0-9a-f\-]{8,})/i) : null;
    // Варіант C: path /candidates/{numericId} (сторінка пошуку резюме /candidates/all/*)
    const mC = !mQ && !mP ? l.href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i) : null;
    const id = mQ?.[1] || mP?.[1] || mC?.[1] || '';
    if (!id) continue;
    if (!applyId) {
      applyId = id;
      // Варіант C: цей числовий ID — прямий resumeId, не applyId
      // Реєструємо одразу щоб getFullCandidateData не пропускав OPEN_ROBOTA_CONTACTS та GET_ROBOTA_RESUME
      if (mC && /^\d+$/.test(id) && !resumeIdMap.has(id)) {
        resumeIdMap.set(id, id);
      }
    }
    if (nameFromLink) continue;

    const txt = (l.textContent || '').trim().replace(/\s+/g, ' ');
    if (looksLikeName(txt)) nameFromLink = txt;
  }

  const linkEl  = card.querySelector('a');
  const _rawHref = linkEl?.href || '';
  // Для CVDB-карток посилання /candidates/{id} є батьківським елементом, а не дочірнім.
  // Якщо applyId — числовий ID кандидата і в картці немає прямого посилання на профіль —
  // будуємо канонічний URL, щоб robotaUrl і sourceUrl в TT були коректними.
  const href = _rawHref.match(/\/candidates\/\d{6,}(?:[/?#]|$)/)
    ? _rawHref
    : (/^\d{6,}$/.test(applyId) ? `https://robota.ua/candidates/${applyId}` : _rawHref);

  // ── Name extraction (5 рівнів пріоритету) ──────────────
  // Пріоритет 0: applyCache — якщо preloadApplyList вже завантажив дані (найнадійніше)
  let fullName = '';
  if (applyId) {
    const stripped = applyId.replace(/-[a-z][a-z]*$/i, ''); // всі буквені суфікси
    const ci = applyCache.get(applyId) || applyCache.get(stripped);
    if (ci) {
      const d = ci?.data || ci;
      const ln  = d?.name?.lastName  || d?.lastName  || '';
      const fn  = d?.name?.firstName || d?.firstName || '';
      // d.name може бути рядком ("Токарева Анастасія") або об'єктом — обидва випадки
      const raw = d?.fullName || d?.full_name
               || (typeof d?.name === 'string' ? d.name : '') || '';
      // Перевагу надаємо структурованим полям над рядком — raw може містити злиття з містом
      const fromApi = (ln && fn) ? `${ln} ${fn}`.trim()
                    : (raw || (ln || fn ? `${ln} ${fn}`.trim() : ''));
      // ЗАХИСТ: "Пропозиція вакансії" — API зберігає назву роботодавця ("Air Wizz") у d.name.
      // Приймаємо лише якщо є структуровані поля (fn+ln обидва) АБО рядок містить кирилицю.
      // Латинські рядки без структурованих полів — ймовірно назва компанії, не кандидата.
      if (looksLikeName(fromApi) && ((ln && fn) || /[А-ЯҐЄІЇа-яґєії]/.test(fromApi))) {
        fullName = fromApi;
      }
    }
  }

  // Пріоритет 1: текст з ?id= посилання (тільки якщо пройшов суворий фільтр)
  if (!fullName && nameFromLink) fullName = nameFromLink;

  // Пріоритет 1.5: santahighlighter — robota.ua маркує цим атрибутом поле ПІБ.
  // Перевіряємо всі такі елементи (може бути кілька: ПІБ, телефон, email),
  // беремо перший що проходить looksLikeName.
  // Приватний режим: ім'я може бути лише першим словом ("Юрій", "Олег") —
  // довіряємо елементу з santahighlighter навіть для 1-слівних значень.
  if (!fullName) {
    for (const el of card.querySelectorAll('[santahighlighter]')) {
      // Заголовки h1/h2/h3 на CVDB-картках містять посаду ("Енергетик", "Директор"),
      // а не ім'я — пропускаємо, щоб не підхопити посаду як ім'я кандидата.
      if (el.closest('h1, h2, h3')) continue;
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (looksLikeName(txt)) { fullName = txt; break; }
      // 1 слово: Кирилиця, велика, 3-30 символів, без цифр, не UI-слово
      if (/^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(txt) && !_UI_WORD_RE.test(txt) && !/\d/.test(txt)) {
        fullName = txt; break;
      }
      // Privacy mode: robota.ua показує прізвище з малої літери ("засядько").
      // santahighlighter на картці (поза заголовком) — це завжди ім'я/прізвище кандидата.
      // Капіталізуємо і приймаємо.
      if (/^[а-яґєіїa-z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(txt) && !/\d/.test(txt)) {
        const cap = txt[0].toUpperCase() + txt.slice(1);
        if (!_UI_WORD_RE.test(cap) && !/ти(ся)?$|ться$/i.test(cap)) { fullName = cap; break; }
      }
    }
  }

  // Пріоритет 2: CSS-селектори (шукаємо конкретні Angular-елементи robota.ua)
  if (!fullName) {
    const nameSelectors = [
      '[class*="resume-full-name"]', '[class*="resume-name"]',
      '[class*="candidate-name"]',   '[class*="full-name"]',
      '[class*="fullName"]',         '[class*="title__name"]',
      '[data-qa="resume-serp-name"]','[data-qa="candidate-name"]',
      'h1', 'h2:not([data-id="cv-speciality"])', 'h3',
      '[class*="name"]:not([class*="vacancy"]):not([class*="company"]):not([class*="job"]):not([class*="status"])',
    ];
    const _headerSels = new Set(['h1', 'h2', 'h3']);
    for (const sel of nameSelectors) {
      const el = card.querySelector(sel);
      if (!el) continue;
      // Беремо текст з першого рівня (або весь, якщо немає дочірніх елементів)
      const text = (el.childNodes.length === 1 && el.firstChild.nodeType === 3
        ? el.textContent
        : el.firstChild?.textContent || el.textContent
      )?.trim();
      if (!text || /\d/.test(text) || !/^[А-ЯҐЄІЇA-Z]/.test(text)) continue;
      if (looksLikeName(text)) { fullName = text; break; }
      // Приватний режим: одне кириличне слово в name-селекторі ("Юрій", "Олег").
      // Для h1/h2/h3 НЕ приймаємо однослівне значення — заголовки часто містять посаду
      // ("Бухгалтер", "Логіст", "Інженер") яка проходить regex але не є іменем.
      if (!_headerSels.has(sel) && /^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(text) && !_UI_WORD_RE.test(text)) {
        fullName = text; break;
      }
    }
  }

  // Пріоритет 3: шаблон ПІБ у тексті картки (СУВОРО: всі слова з великої, без /i)
  if (!fullName) {
    const lines = (card.textContent || '').split(/\n+/)
      .map(l => l.trim()).filter(l => l.length >= 4 && l.length < 70);
    const nameLine = lines.find(l => looksLikeName(l));
    if (nameLine) fullName = nameLine;
  }

  // Пріоритет 4: абсолютний fallback (остання надія)
  if (!fullName) {
    const text = card.textContent || '';
    // Збираємо всі рядки що починаються з ВЕЛИКОЇ кириличної і не мають цифр
    const p4lines = text.trim().split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && l.length < 70 && /^[А-ЯҐЄІЇA-Z]/.test(l) && !/\d/.test(l));
    // Перевага: рядок де ВСІ слова з ВЕЛИКОЇ → це ім'я, не посада
    // ("Транспортний логіст" — "логіст" з маленької → відхиляємо; "Уляна Джанджала" → приймаємо)
    const p4allCaps = p4lines.find(l => {
      const ws = l.replace(/,.*$/, '').trim().split(/\s+/).filter(Boolean);
      return ws.length >= 2 && ws.length <= 4 && ws.every(w => /^[А-ЯҐЄІЇA-Z]/.test(w));
    });
    const p4candidate = p4allCaps || p4lines[0] || '';
    if (p4candidate) {
      fullName = p4candidate
        .replace(/\s*\d+\s*(рок|грн|тис|%|р\.).*$/i, '')
        .trim().split(/\s{2,}/)[0] || '';
      // Відкидаємо якщо перше слово з маленької — це не ім'я
      if (fullName && !/^[А-ЯҐЄІЇA-Z]/.test(fullName)) fullName = '';
      // Прибираємо кириличні злиття: "ОлексійовичХарків" (велика після 1-ї позиції)
      // Латинські великі літери всередині слова (напр. "McDonald") — дозволяємо
      if (fullName) {
        fullName = fullName.split(/\s+/)
          .filter(w => !(w.length > 1 && /[А-ЯҐЄІЇ]/.test(w.slice(1))))
          .join(' ');
        if (fullName && !/^[А-ЯҐЄІЇA-Z]/.test(fullName)) fullName = '';
      }
    }
  }

  // ── UUID Interaction lookup: якщо є ім'я але немає кешу під UUID ────────────
  // apply/list повертає Interaction ID вже як INT (GUID→INT), UUID більше не є в API.
  // Будуємо міст: fullName (з DOM) → nameApplyIdMap → numericId → applyCache → UUID
  if (applyId && fullName) {
    const _uStrip = applyId.replace(/-[a-z][a-z]*$/i, '');
    if (/^[0-9a-f]{32}$/i.test(_uStrip) && !applyCache.has(_uStrip)) {
      const _nk = fullName.toLowerCase().replace(/\s+/g, ' ');
      if (nameApplyIdMap.has(_nk)) {
        const { numericId: _nid, item: _ni } = nameApplyIdMap.get(_nk);
        applyCache.set(applyId, _ni);
        applyCache.set(_uStrip, _ni);
        numericApplyIdMap.set(applyId, _nid);
        numericApplyIdMap.set(_uStrip, _nid);
        if (_ni.resumeId) {
          resumeIdMap.set(applyId, String(_ni.resumeId));
          resumeIdMap.set(_uStrip, String(_ni.resumeId));
        }
        console.log('[TT] UUID→numericId за іменем:', _nk.substring(0, 25), '→', _nid);
      }
    }
  }

  const { lastName, firstName, patronymic } = parseNameParts(fullName);

  const imgEl   = card.querySelector('alliance-employer-resume-circle-photo img, img[src*="http"]');
  const picture = imgEl?.src?.startsWith('http') ? imgEl.src : '';

  const fillMatch = (card.textContent || '').match(/(\d+)%/);
  const fill = fillMatch ? fillMatch[1] + '%' : '';

  return {
    applyId,
    firstName, lastName, patronymic,
    fullName: `${lastName} ${firstName} ${patronymic}`.trim(),
    picture, fill, href,
    vacancyId: getVacancyId()
  };
}

// ── Отримати повні дані кандидата через API ────────────────
async function getFullCandidateData(applyId) {
  const strApplyId = String(applyId || '');
  console.log('[TT] getFullCandidateData →', strApplyId);

  // ── Resolve stripped / numeric IDs (потрібні для всіх API-звернень) ──
  // Знімаємо БУДЬ-ЯКИЙ буквенний URL-суфікс robota.ua:
  // '98516070-attach' → '98516070', '90319218-prof' → '90319218',
  // 'a4ecf361...-interaction' → 'a4ecf361...'
  const stripped       = strApplyId.replace(/-[a-z][a-z]*$/i, '');

  // Повертаємо з кешу тільки якщо:
  //   1. є контакти (phone/email) — показник що кандидат вже відкривався (spy перехоплення)
  //   2. є дані резюме (experiences, education, about тощо) — spy повертає повну відповідь
  // Без умови 2: preloadApplyList дає мінімальні дані без резюме-деталей → resumeText буде пустим.
  // Якщо є лише контакти без резюме-тіла — продовжуємо до GET_ROBOTA_RESUME для повного тексту.
  const _earlyCache = applyCache.get(strApplyId) || applyCache.get(stripped);
  // _needsLetter: кандидат має covering letter, але текст ще не завантажено
  const _needsLetter = !!(_earlyCache?.coveringLetterExists && !_earlyCache?._letterText);
  if (_earlyCache && !_needsLetter) {
    const d = _earlyCache?.data || _earlyCache;
    const _hasContacts = !!(d?.contactInfo?.phone?.phoneNumber || d?.contactInfo?.email ||
                             d?.phone || d?.email || d?.phoneNumber);
    // Перевіряємо чи є resume-деталі (spy / GET_ROBOTA_RESUME повертають ці поля)
    const _hasResumeBody = !!(d?.experiences || d?.experience || d?.workExperiences ||
                               d?.workExperience || d?.expiriences ||
                               d?.education || d?.educations ||
                               d?.about || d?.summary || d?.skills);
    if (_hasContacts && _hasResumeBody) {
      console.log('[TT] early-cache (full) →', strApplyId);
      if (!_earlyCache._strApplyId) _earlyCache._strApplyId = strApplyId;
      return _earlyCache;
    }
    // Контакти є але резюме-тіло відсутнє (preload-мінімум) →
    // продовжуємо до GET_ROBOTA_RESUME щоб отримати experiences/education/about
    if (_hasContacts) {
      console.log('[TT] early-cache (contacts only, no resume body) →', strApplyId, '— fetching full resume');
    }
  }

  // numericApplyIdMap: UUID → числовий ID (будується під час preloadApplyList)
  // ВАЖЛИВО: let (не const) — може оновитись після GET_ROBOTA_APPLY
  let numericApplyId = numericApplyIdMap.get(strApplyId)  ||
                       numericApplyIdMap.get(stripped)     ||
                       (/^\d+$/.test(strApplyId) ? strApplyId : '') ||
                       (/^\d+$/.test(stripped)   ? stripped   : '') || '';

  // ── Resolve resumeId ──────────────────────────────────────
  let resumeId = resumeIdMap.get(strApplyId) || resumeIdMap.get(stripped) ||
                 resumeIdMap.get(numericApplyId);

  if (!resumeId) {
    const ci = applyCache.get(strApplyId) || applyCache.get(numericApplyId);
    if (ci) {
      const d  = ci?.data || ci;
      const rId = d?.resumeId || d?.resume_id || d?.ResumeId;
      if (rId) resumeId = String(rId);
    }
  }

  // ── Fallback: GET /apply/{id} → витягнути resumeId та числовий applyId ───
  // Пробуємо оригінальний, stripped та числовий — один із них спрацює.
  // CRITICAL для UUID-кандидатів: витягуємо числовий applyId з відповіді
  // (UUID не містить цифр → numericApplyId = '' до цього моменту)
  if (!resumeId) {
    // POST /apply (GetApply) підтримує лише числові ID
    // UUID-кандидати: числовий numericApplyId вже шукається через POST /apply/view у кроці 1
    const idsToTry = [...new Set([stripped, numericApplyId]
      .filter(id => id && /^\d+$/.test(id))           // лише числові
    )];
    for (const tryId of idsToTry) {
      try {
        const applyResp = await bgMsg({ type: 'GET_ROBOTA_APPLY', applyId: tryId });
        if (applyResp?.ok && applyResp?.data) {
          const ad  = applyResp.data?.data || applyResp.data;

          // Витягуємо resumeId
          const rId = ad?.resumeId || ad?.resume_id || ad?.ResumeId
                   || ad?.resume?.id || ad?.cvId || ad?.cv_id || '';
          if (rId) resumeId = String(rId);

          // ── НОВИЙ КОД: витягуємо числовий applyId для UUID-кандидатів ──
          // ad.id — числовий ідентифікатор відгуку в robota.ua (≠ UUID interactionId)
          const numFromResp = String(ad?.id || ad?.applyId || ad?.apply_id || '');
          if (numFromResp && /^\d+$/.test(numFromResp) && !numericApplyId) {
            numericApplyId = numFromResp;
            numericApplyIdMap.set(strApplyId, numericApplyId);
            numericApplyIdMap.set(stripped,   numericApplyId);
            console.log('[TT] numericApplyId знайдено з GET_ROBOTA_APPLY:', numericApplyId);
          }

          // Витягуємо текст covering letter з GET /apply/{id} відповіді
          const letterFromApply = ad?.letter || ad?.coveringLetter
                               || ad?.coveringLetterText || ad?.letterText || '';
          if (letterFromApply) {
            const _ci2 = applyCache.get(strApplyId) || applyCache.get(stripped);
            if (_ci2 && !_ci2._letterText) _ci2._letterText = String(letterFromApply).trim();
            console.log('[TT] GET_ROBOTA_APPLY letter знайдено, довжина:', letterFromApply.length);
          }

          // Оновлюємо resumeIdMap з усіма відомими ID
          if (resumeId) {
            resumeIdMap.set(strApplyId, resumeId);
            resumeIdMap.set(stripped, resumeId);
            if (numericApplyId) resumeIdMap.set(numericApplyId, resumeId);
          }

          if (!applyCache.has(strApplyId)) {
            ad._resumeType = ad.resumeType || ad.resume_type || '';
            applyCache.set(strApplyId, ad);
            if (stripped !== strApplyId) applyCache.set(stripped, ad);
            if (numericApplyId && !applyCache.has(numericApplyId)) applyCache.set(numericApplyId, ad);
          }
          if (resumeId) break; // знайшли resumeId — далі не перебираємо
        }
      } catch (e) {}
    }
  }

  // Відстежуємо чи resumeId — реальний (не просто applyId як fallback)
  // Якщо resumeId не знайдено (interaction-тип без CV) — спочатку пропускаємо
  // OPEN_ROBOTA_CONTACTS та GET_ROBOTA_RESUME; але AFTER GET_ROBOTA_APPLY_VIEW
  // може повернути реальний resumeId — тоді оновлюємо цей прапор (let, не const).
  let resumeIdIsApplyId = !resumeId;
  if (!resumeId) resumeId = numericApplyId || strApplyId;

  // ── Знайти resumeType у кеші ─────────────────────────────
  const cachedItem = applyCache.get(strApplyId) || applyCache.get(stripped) || applyCache.get(numericApplyId);
  // candidateType — нова назва поля в API 2025 (ApplicationWithFile, VacancyInteraction тощо)
  const _rtRawGFCD = cachedItem?._resumeType || cachedItem?.resumeType
                  || cachedItem?.resume_type || cachedItem?.candidateType || '';
  const _rtMapGFCD = {
    applicationwithfile: 'AttachedFile', attachedfile: 'AttachedFile', attach: 'AttachedFile',
    applicationwithresume: 'Notepad', notepad: 'Notepad',
    selectedresume: 'Selected', selected: 'Selected',
    application: 'NoCvApply', nocvapply: 'NoCvApply',
    vacancyinteraction: 'Interaction', interaction: 'Interaction',
    vacancyoffered: 'VacancyOffered', recommended: 'Recommended',
  };
  let resumeType = _rtMapGFCD[_rtRawGFCD.toLowerCase()] || _rtRawGFCD;
  // Fallback: витягуємо resumeType із суфіксу URL-рядка applyId
  // Маппінг URL-суфіксу → API resumeType (обидва варіанти enum)
  // '-attach'/'-attachedfile' → 'Attach', '-prof'/'-notepad' → 'Notepad', '-selected' → 'Selected'
  if (!resumeType && stripped !== strApplyId) {
    const sfx = strApplyId.slice(stripped.length + 1).toLowerCase();
    const sfxMap = {
      attach: 'AttachedFile', attachedfile: 'AttachedFile', file: 'AttachedFile',
      prof: 'Notepad', notepad: 'Notepad', note: 'Notepad', resume: 'Notepad',
      selected: 'Selected', cv: 'Selected',
      interaction: 'Interaction'
    };
    resumeType = sfxMap[sfx] || (sfx ? sfx.charAt(0).toUpperCase() + sfx.slice(1) : '');
  }

  console.log('[TT] IDs resolved →', { strApplyId, numericApplyId, resumeId, resumeType });

  // ── 0. Fetch covering letter (якщо _needsLetter і є numericApplyId) ──
  // Виконується тільки для кандидатів з coveringLetterExists=true але без _letterText у кеші
  if (_needsLetter && numericApplyId) {
    try {
      console.log('[TT] _needsLetter → GET_ROBOTA_APPLY для листа, id:', numericApplyId);
      const letterResp = await bgMsg({ type: 'GET_ROBOTA_APPLY', applyId: numericApplyId });
      if (letterResp?.ok && letterResp?.data) {
        const ad = letterResp.data?.data || letterResp.data;
        const letterText = ad?.letter || ad?.coveringLetter
                        || ad?.coveringLetterText || ad?.letterText || '';
        if (letterText) {
          const _ci = _earlyCache || applyCache.get(strApplyId) || applyCache.get(stripped);
          if (_ci) _ci._letterText = String(letterText).trim();
          console.log('[TT] _needsLetter: letter отримано, довжина:', letterText.length);
        }
      }
    } catch(_) {}
    // Якщо маємо контакти в кеші — повертаємо одразу (без зайвих API-викликів)
    if (_earlyCache) {
      const _dCheck = _earlyCache?.data || _earlyCache;
      if (_dCheck?.phone || _dCheck?.email || _dCheck?.contactInfo?.email) {
        if (!_earlyCache._strApplyId) _earlyCache._strApplyId = strApplyId;
        return _earlyCache;
      }
    }
  }

  // ── 1. Переглянути відгук (POST /apply/view/{id}?resumeType=...) ──
  // apply/view приймає ТІЛЬКИ числовий ID — UUID повертає 400 завжди.
  // Якщо numericApplyId невідомий (UUID-кандидат без маппінгу) — пропускаємо.
  let contactsFromView = null;
  const viewId = numericApplyId; // тільки числовий ID
  if (viewId) {
    try {
      // apply/view приймає лише: AttachedFile, Notepad, Selected, NoCvApply
      // Interaction, VacancyOffered, Recommended — невалідні enum → передаємо порожній рядок
      const _applyViewType = ['AttachedFile','Notepad','Selected','NoCvApply'].includes(resumeType)
        ? resumeType : '';
      const vr = await bgMsg({
        type:       'GET_ROBOTA_APPLY_VIEW',
        applyId:    viewId,
        resumeType: _applyViewType
      });
      console.log('[TT] GET_ROBOTA_APPLY_VIEW', viewId.substring(0, 12), '→', vr?.ok, vr?.data ? 'data OK' : 'no data', vr?.error || '');
      if (vr?.ok && vr.data) {
        contactsFromView = vr.data;
        // Витягуємо numericApplyId з відповіді (UUID-виклик → числовий id у відповіді)
        try {
          const dbgV = vr.data?.data || vr.data;
          const numFromView = String(dbgV?.id || dbgV?.applyId || '');
          if (numFromView && /^\d+$/.test(numFromView) && !numericApplyId) {
            numericApplyId = numFromView;
            numericApplyIdMap.set(strApplyId, numericApplyId);
            numericApplyIdMap.set(stripped,   numericApplyId);
            console.log('[TT] numericApplyId з APPLY_VIEW UUID:', numericApplyId);
          }
          // ── Оновлюємо resumeId з відповіді apply/view ──
          // Для "offered" кандидатів (прикріплений профіль robota.ua) apply/view
          // повертає реальний resumeId — дозволяємо OPEN_ROBOTA_CONTACTS + GET_ROBOTA_RESUME.
          if (resumeIdIsApplyId) {
            const rIdFromView = String(
              dbgV?.resumeId    || dbgV?.resume_id || dbgV?.ResumeId
           || dbgV?.resume?.id || dbgV?.cvId       || dbgV?.cv_id || ''
            );
            if (rIdFromView && rIdFromView !== '0'
                && rIdFromView !== strApplyId
                && rIdFromView !== numericApplyId
                && rIdFromView !== stripped) {
              resumeId          = rIdFromView;
              resumeIdIsApplyId = false;
              resumeIdMap.set(strApplyId, resumeId);
              resumeIdMap.set(stripped,   resumeId);
              if (numericApplyId) resumeIdMap.set(numericApplyId, resumeId);
              console.log('[TT] ✅ resumeId з APPLY_VIEW:', resumeId, '→ resumeIdIsApplyId = false');
            }
          }
          console.log('[TT] APPLY_VIEW ключі:', Object.keys(dbgV || {}));
          console.log('[TT] APPLY_VIEW phone/email:',
            'phone=', dbgV?.phone,
            'phoneNumber=', dbgV?.phoneNumber,
            'mobilePhone=', dbgV?.mobilePhone,
            'email=', dbgV?.email,
            'contactInfo=', JSON.stringify(dbgV?.contactInfo || {})
          );
          // Витягуємо текст covering letter (apply/view повертає повну відповідь відгуку)
          const letterFromView = dbgV?.letter || dbgV?.coveringLetter
                              || dbgV?.coveringLetterText || dbgV?.letterText
                              || dbgV?.applyText || dbgV?.text || '';
          if (letterFromView) {
            contactsFromView._letterText = String(letterFromView).trim();
            console.log('[TT] APPLY_VIEW letter знайдено, довжина:', letterFromView.length);
            // Зберігаємо на cached item одразу
            const _ci = applyCache.get(strApplyId) || applyCache.get(stripped);
            if (_ci && !_ci._letterText) _ci._letterText = contactsFromView._letterText;
          }
        } catch (_) {}
      }
    } catch (e) { console.error('[TT] GET_ROBOTA_APPLY_VIEW error:', e); }
  } else {
    console.log('[TT] viewId відсутній — /apply/view пропускаємо');
  }

  // ── Helper: злиття контактів у цільовий об'єкт ──────────
  function mergeContacts(target, source) {
    if (!source) return;
    const s = source?.data || source;
    if (!target.contactInfo) target.contactInfo = {};
    // Підтримуємо всі відомі формати robota.ua API (REST + GraphQL)
    const phone = s.phone                           || s.phoneNumber
               || s.mobilePhone                     || s.mobile
               || s.contacts?.phone                 || s.contacts?.mobilePhone
               || s.contactInfo?.phone?.phoneNumber
               || (typeof s.contactInfo?.phone === 'string' ? s.contactInfo.phone : '')
               || s.contactInfo?.mobilePhone
               || s.contactInfo?.phones?.[0]?.phoneNumber
               || s.contactInfo?.phones?.[0]?.number
               || s.phones?.[0]?.phoneNumber
               || s.phones?.[0]?.number
               || (typeof s.phones?.[0] === 'string' ? s.phones[0] : '')
               || '';
    const email = s.email           || s.eMail      || s.emailAddress
               || s.contacts?.email || s.contacts?.eMail
               || s.contactInfo?.email
               || (typeof s.contactInfo?.email === 'object' ? s.contactInfo?.email?.value : '')
               || s.contactInfo?.emails?.[0]?.value
               || s.contactInfo?.emails?.[0]
               || (typeof s.emails?.[0] === 'string' ? s.emails[0] : '')
               || s.emails?.[0]?.value
               || '';
    if (phone && !target.contactInfo?.phone?.phoneNumber) {
      target.contactInfo.phone = { phoneNumber: phone };
    }
    if (email && !target.contactInfo?.email) target.contactInfo.email = email;
    if (phone && !target.phone) target.phone = phone;
    if (email && !target.email) target.email = email;
    // Також зберігаємо ім'я якщо прийшло з джерела (напр. /apply/view повертає name.firstName)
    if (!target.firstName && (s.name?.firstName || s.firstName)) {
      target.firstName = s.name?.firstName || s.firstName;
    }
    if (!target.lastName && (s.name?.lastName || s.lastName || s.name?.surName || s.surName)) {
      target.lastName = s.name?.lastName || s.lastName || s.name?.surName || s.surName;
    }
  }

  // ── 2+3. OPEN_CONTACTS та GET_RESUME паралельно ───────────
  let contactsFromReveal = null;
  if (resumeIdIsApplyId) {
    console.log('[TT] OPEN_CONTACTS + GET_RESUME пропускаємо — interaction-кандидат без CV');
  } else {
    const [cr, resumeResp] = await Promise.all([
      bgMsg({
        type:      'OPEN_ROBOTA_CONTACTS',
        resumeId,
        vacancyId: cachedItem?.vacancyId || getVacancyId(),
        applyId:   numericApplyId || strApplyId
      }).catch(e => { console.error('[TT] OPEN_ROBOTA_CONTACTS error:', e); return null; }),
      bgMsg({ type: 'GET_ROBOTA_RESUME', resumeId })
        .catch(e => { console.error('[TT] GET_ROBOTA_RESUME error:', e); return null; })
    ]);

    console.log('[TT] OPEN_ROBOTA_CONTACTS →', cr?.ok, cr?.data ? 'data OK' : 'no data');
    if (cr?.ok && cr.data) contactsFromReveal = cr.data;

    console.log('[TT] GET_ROBOTA_RESUME →', resumeResp?.ok, resumeResp?.data ? 'data OK' : 'no data');
    if (resumeResp?.ok && resumeResp.data) {
      const fullData = resumeResp.data;
      const d = fullData?.data || fullData;

      mergeContacts(d, contactsFromView);
      mergeContacts(d, contactsFromReveal);

      fullData._numericApplyId = numericApplyId;
      fullData._strApplyId     = strApplyId;
      fullData._resumeType     = resumeType;
      fullData._resumeId       = (!resumeIdIsApplyId && resumeId) ? resumeId : '';
      if (!fullData._letterText) {
        const _lt = applyCache.get(strApplyId)?._letterText || applyCache.get(stripped)?._letterText || '';
        if (_lt) fullData._letterText = _lt;
      }

      applyCache.set(strApplyId, fullData);
      if (resumeId && resumeId !== strApplyId) applyCache.set(resumeId, fullData);
      return fullData;
    }
  }

  // ── Резюме не отримано — повертаємо контакти з open/view ──
  // (OPEN_ROBOTA_CONTACTS → true data OK навіть коли GET_ROBOTA_RESUME fails)
  // ВАЖЛИВО: якщо API повернув не-об'єкт (наприклад число 8 = кількість операцій),
  // ігноруємо — contactsFromReveal/View мають бути plain object
  const revealObj = (contactsFromReveal && typeof contactsFromReveal === 'object') ? contactsFromReveal : null;
  const viewObj   = (contactsFromView   && typeof contactsFromView   === 'object') ? contactsFromView   : null;
  if (revealObj || viewObj) {
    const rv = revealObj ? (revealObj?.data || revealObj) : {};
    const cv = viewObj   ? (viewObj?.data   || viewObj)   : {};
    // reveal перезаписує view — /resume/open надійніше за /apply/view
    const merged = Object.assign({}, cv, rv);
    if (!merged.contactInfo) merged.contactInfo = {};
    // Нормалізуємо телефон та email у merged
    // Підтримуємо всі відомі формати robota.ua API (reveal та view можуть мати різну структуру)
    const mPhone = rv.phone           || rv.phoneNumber
                || rv.mobilePhone     || rv.mobile
                || rv.contacts?.phone || rv.contacts?.mobilePhone
                || rv.contactInfo?.phone?.phoneNumber
                || rv.contactInfo?.phones?.[0]?.phoneNumber
                || rv.contactInfo?.phones?.[0]?.number
                || rv.phones?.[0]?.phoneNumber
                || rv.phones?.[0]?.number
                || (typeof rv.phones?.[0] === 'string' ? rv.phones[0] : '')
                || cv.phone           || cv.phoneNumber
                || cv.mobilePhone     || cv.mobile
                || cv.contacts?.phone
                || cv.contactInfo?.phone?.phoneNumber
                || cv.contactInfo?.phones?.[0]?.phoneNumber
                || cv.contactInfo?.phones?.[0]?.number
                || (typeof cv.phones?.[0] === 'string' ? cv.phones[0] : '')
                || '';
    const mEmail = rv.email  || rv.eMail  || rv.emailAddress
                || rv.contacts?.email
                || rv.contactInfo?.email
                || rv.contactInfo?.emails?.[0]?.value
                || rv.contactInfo?.emails?.[0]
                || (typeof rv.emails?.[0] === 'string' ? rv.emails[0] : '')
                || cv.email  || cv.eMail  || cv.emailAddress
                || cv.contacts?.email
                || cv.contactInfo?.email
                || (typeof cv.emails?.[0] === 'string' ? cv.emails[0] : '')
                || '';
    if (mPhone) { merged.contactInfo.phone = { phoneNumber: ttNormalizePhone(mPhone) }; merged.phone = ttNormalizePhone(mPhone); }
    if (mEmail && ttIsRealEmail(mEmail)) { merged.contactInfo.email = String(mEmail); merged.email = String(mEmail); }
    merged._numericApplyId = numericApplyId;
    merged._strApplyId     = strApplyId;   // повний ID з суфіксом (для завантаження файлу)
    merged._resumeType     = resumeType;
    merged._resumeId       = (!resumeIdIsApplyId && resumeId) ? resumeId : '';
    // Прокидуємо _letterText з contactsFromView або cached item
    const _ltMerged = contactsFromView?._letterText
                   || applyCache.get(strApplyId)?._letterText
                   || applyCache.get(stripped)?._letterText || '';
    if (_ltMerged) merged._letterText = _ltMerged;
    applyCache.set(strApplyId, merged);
    return merged;
  }

  // ── DOM-скрапінг для interaction-кандидатів ──────────────────────────────
  // Коли профіль кандидата відкритий на сторінці, robota.ua показує контакти
  // у вигляді <a href="tel:..."> та <a href="mailto:...">.
  // Це єдиний спосіб отримати контакти interaction-типу — API не повертає їх.
  if (resumeIdIsApplyId) {
    try {
      // Скрапимо тільки якщо URL-параметр ?id= відповідає цьому кандидату —
      // інакше панель може показувати ІНШОГО кандидата
      const curUrlId    = (location.href.match(/[?&]id=([^&\s#]+)/i) || [])[1] || '';
      const strippedUrl = curUrlId.replace(/-(interaction|attach|view|cv)$/i, '');
      const urlOk = curUrlId === strApplyId || strippedUrl === stripped || curUrlId === stripped;

      if (!urlOk) {
        console.log('[TT] DOM-скрапінг пропускаємо — URL не відповідає:', curUrlId, '≠', strApplyId);
      } else {
        const panelEl = document.querySelector('alliance-employer-candidates-candidate-panel-desktop');
        const scope   = panelEl || document;

        // deepQueryAll пробиває Shadow DOM якщо він є
        const telLinks  = deepQueryAll(scope, 'a[href^="tel:"]');
        const mailLinks = deepQueryAll(scope, 'a[href^="mailto:"]');
        let rawPhone  = telLinks.length  ? telLinks[0].href.replace(/^tel:/, '').trim() : '';
        let rawEmail  = mailLinks.length ? mailLinks[0].href.replace(/^mailto:/, '').trim() : '';

        // Fallback: форматований телефон у тексті (+38 (068) 227 - 20 - 87)
        if (!rawPhone && panelEl) {
          const allTxt = extractShadowText(panelEl);
          const pm = allTxt.match(
            /(?:(?:\+?38)[\s-]*)?\(?(0\d{2})\)?[\s-.]*(\d{3})[\s-.]*(\d{2})[\s-.]*(\d{2})\b/
          );
          if (pm) rawPhone = '+38' + pm[1] + pm[2] + pm[3] + pm[4];
        }
        // Fallback: email у тексті
        if (!rawEmail && panelEl) {
          const allTxt = extractShadowText(panelEl);
          const em = allTxt.match(/[\w.+\-]+@[\w\-]+\.[\w.]+/);
          if (em && ttIsRealEmail(em[0])) rawEmail = em[0];
        }

        const domPhone  = rawPhone ? ttNormalizePhone(rawPhone) : '';
        const domEmail  = (rawEmail && ttIsRealEmail(rawEmail)) ? rawEmail : '';
        if (domPhone || domEmail) {
          const domData = {};
          if (domPhone) domData.phone = domPhone;
          if (domEmail) domData.email = domEmail;
          domData._numericApplyId = numericApplyId;
          domData._strApplyId     = strApplyId;
          domData._resumeType     = resumeType;
          domData._resumeId       = (!resumeIdIsApplyId && resumeId) ? resumeId : '';
          // Прокидуємо _letterText якщо вже є
          const _ltDom = contactsFromView?._letterText
                      || applyCache.get(strApplyId)?._letterText
                      || applyCache.get(stripped)?._letterText || '';
          if (_ltDom) domData._letterText = _ltDom;
          applyCache.set(strApplyId, domData);
          console.log('[TT] 📍 DOM-скрапінг → phone:', domPhone || '(порожньо)', '| email:', domEmail || '(порожньо)');
          return domData;
        } else {
          console.log('[TT] DOM-скрапінг: посилань tel:/mailto: та телефону в тексті не знайдено');
        }
      }
    } catch (_) {}
  }

  // ── dracula.robota.ua fallback для ПІБ ───────────────────────────────────
  // Якщо жоден REST-ендпоінт не дав ім'я, але є resumeId — питаємо GraphQL.
  // getResumeFile повертає personal.firstName + personal.surName напряму.
  // Не викликаємо якщо resumeId = applyId (interaction без CV-профілю).
  if (!resumeIdIsApplyId && resumeId && resumeId !== strApplyId && resumeId !== numericApplyId) {
    const _cached = applyCache.get(strApplyId) || applyCache.get(stripped);
    const _cd = _cached?.data || _cached;
    const _hasName = _cd?.firstName || _cd?.lastName || _cd?.name?.firstName;
    if (!_hasName) {
      try {
        const _dr = await bgMsg({ type: 'DRACULA_GET_RESUME_INFO', resumeId });
        if (_dr?.ok && (_dr.firstName || _dr.lastName)) {
          console.log('[TT] 🐲 dracula ПІБ fallback:', _dr.firstName, _dr.lastName);
          const _drData = Object.assign({}, _cached || {}, {
            firstName: _dr.firstName || _cd?.firstName || '',
            lastName:  _dr.lastName  || _cd?.lastName  || '',
            _numericApplyId: numericApplyId,
            _strApplyId:     strApplyId,
            _resumeType:     resumeType,
            _resumeId:       resumeId
          });
          applyCache.set(strApplyId, _drData);
          if (stripped !== strApplyId) applyCache.set(stripped, _drData);
          return _drData;
        }
      } catch (_) {}
    }
  }

  return applyCache.get(strApplyId) || applyCache.get(stripped) || null;
}

// ── Форматуємо JSON-резюме robota.ua в текст ──────────────
// Конвертує ISO-дату "2025-12" або "2025-12-01" → "12.2025"
function fmtDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // "2025-12-01" або "2025-12" → "12.2025"
  const isoM = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoM) return `${isoM[2]}.${isoM[1]}`;
  // "12.2025" або "12/2025" — вже готово
  return s;
}

// Видаляємо HTML-теги та декодуємо базові HTML entities
function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|h[1-6]|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatResumeText(d) {
  const lines = [];

  // Бажана посада / спеціальність
  // apply/list: "speciality"; /resume: "position"/"specialty"/"title"
  const position = d.position || d.speciality || d.specialty || d.jobTitle || '';
  if (position) lines.push(`Посада: ${position}`);

  // Зарплата — apply/list: {salary: 23000, currencyId: "Ua"}
  //             /resume:   {salary: {amount: 23000, currency: "UAH"}}
  const salAmt = typeof d.salary === 'number'
    ? d.salary
    : (d.salary?.amount ?? d.salary?.salaryAmount ?? d.salary?.from
    ?? d.desiredSalary?.amount ?? d.desiredSalary?.from ?? null);
  if (salAmt) {
    const salCur = typeof d.salary === 'number'
      ? (d.currencyId || 'UAH')
      : (d.salary?.currency || d.salary?.currencyId || d.desiredSalary?.currency || 'UAH');
    lines.push(`Зарплата: ${salAmt} ${salCur}`);
  }

  // Про себе / Summary
  // apply/list: немає окремого поля; /resume: "about"/"summary"
  const about = d.about || d.summary || d.aboutMe || '';
  if (about) lines.push(`\n${stripHtml(about)}`);

  // skillsSummary — HTML-рядок з apply/list (навички/про себе)
  const skillsSumHtml = d.skillsSummary || '';
  if (skillsSumHtml) {
    const stripped = stripHtml(skillsSumHtml);
    if (stripped && stripped !== about) lines.push(`\n${stripped}`);
  }

  // Досвід роботи — перебираємо всі відомі назви поля robota.ua API
  const exp = d.experiences      // ← основне поле robota.ua API (множина!)
           || d.experience
           || d.workExperiences
           || d.workExperience
           || d.expiriences      // ← відомий друк у деяких версіях API
           || d.workHistory
           || d.jobs
           || d.career
           || [];
  if (Array.isArray(exp) && exp.length) {
    lines.push('\n── ДОСВІД РОБОТИ ──');
    exp.forEach(e => {
      const pos  = e.position    || e.title      || e.jobTitle  || '';
      const comp = e.companyName || e.company    || e.employer  || e.organization || '';
      // apply/list: startWork/endWork; /resume: dateStart/startDate/beginDate
      const from = fmtDate(e.dateStart  || e.startDate  || e.beginDate || e.startWork || e.from || '');
      const isCur = e.isCurrentJob || e.isCurrent || e.current || false;
      const to   = isCur ? 'по теперішній час'
                         : fmtDate(e.dateEnd || e.endDate || e.finishDate || e.endWork || e.to || '');
      if (pos || comp) lines.push(`\n${pos}${pos && comp ? ' — ' : ''}${comp}`);
      if (from || to)  lines.push(`${from}${from && to ? ' – ' : ''}${to}`);
      const desc = e.description || e.responsibilities || e.duties || '';
      if (desc) lines.push(stripHtml(desc).substring(0, 600));
    });
  }

  // Освіта
  // apply/list: {title, speciality, yearOfGraduation, location}
  // /resume:    {name/institutionName, specialty/specialization, year/graduationYear}
  const edu = d.educations || d.education || d.studies || [];
  if (Array.isArray(edu) && edu.length) {
    lines.push('\n── ОСВІТА ──');
    edu.forEach(e => {
      const inst = e.name || e.institutionName || e.university || e.school
                || e.establishment || e.title || '';
      const spec = e.specialty || e.specialization || e.faculty || e.field
                || e.speciality || '';
      const yearRaw = e.year || e.graduationYear || e.yearOfGraduation || e.endYear || e.finishYear || '';
      const year = yearRaw ? fmtDate(String(yearRaw)) : '';
      const loc  = e.location || e.city || '';
      let eduLine = inst;
      if (spec) eduLine += ` — ${spec}`;
      if (year) eduLine += ` (${year})`;
      if (loc && !inst.includes(loc)) eduLine += `, ${loc}`;
      if (eduLine.trim()) lines.push(`\n${eduLine}`);
    });
  }

  // Навички
  const skills = d.skills || d.hardSkills || d.skillKeywords || [];
  const addSkills = d.additionalSkills || d.additionalInfo || '';
  if ((Array.isArray(skills) && skills.length) || addSkills) {
    lines.push('\n── НАВИЧКИ ──');
    if (Array.isArray(skills) && skills.length) {
      const names = skills.map(s => s.name || s.title || s.skillName || (typeof s === 'string' ? s : '')).filter(Boolean);
      if (names.length) lines.push(names.join(', '));
    }
    if (addSkills) lines.push(stripHtml(addSkills).trim());
  }

  // Мови
  const langs = d.languages || d.languageSkills || d.foreignLanguages || [];
  if (Array.isArray(langs) && langs.length) {
    lines.push('\n── МОВИ ──');
    langs.forEach(l => {
      const name  = l.name  || l.language     || l.languageName  || '';
      const level = l.level || l.proficiency  || l.levelName     || l.languageLevel || '';
      if (name) lines.push(`${name}${level ? ` — ${level}` : ''}`);
    });
  }

  return lines.join('\n').trim();
}

// ── Збагатити дані з API ───────────────────────────────────
function enrichInfo(info, apiData) {
  if (!apiData) return info;
  const enriched = { ...info };
  const d = apiData.data || apiData;

  // Name (фільтруємо UI-слова на випадок якщо API поверне несподіваний рядок)
  // surName — robota.ua GraphQL (dracula API): personal.surName = прізвище
  let _apiFn = d.name?.firstName || d.firstName || d.personal?.firstName || '';
  let _apiLn = d.name?.lastName  || d.lastName  || d.name?.surName
            || d.surName         || d.personal?.surName || '';

  // Якщо немає окремих полів — пробуємо парсити name як рядок або fullName
  if (!_apiFn && !_apiLn) {
    const _nameStr = (typeof d.name === 'string' ? d.name : '')
                  || d.fullName || d.full_name || '';
    if (_nameStr && looksLikeName(_nameStr)) {
      const _p = parseNameParts(_nameStr);
      _apiFn = _p.firstName;
      _apiLn = _p.lastName;
    }
  }

  // Запам'ятовуємо DOM-одиничне слово (parseNameParts кладе його у firstName)
  // — воно може бути lastName, якщо API дасть інший firstName
  const _domSingleWord = (info.firstName && !info.lastName && !looksLikeName(`${info.firstName} ${info.lastName}`.trim()))
                         ? info.firstName : '';

  // Замінюємо firstName тільки якщо:
  //   a) API дав ОБИДВА поля (надійно) — замінюємо завжди
  //   b) API дав лише firstName, а lastName у нас ще немає — беремо як fallback
  // НЕ замінюємо якщо API дав лише firstName, а info (DOM/checkCache) вже має повне 2-словне ім'я:
  // тип "Пропозиція вакансії" зберігає лише прізвище у firstName — це б зламало правильне ПІБ
  if (_apiFn && !_UI_WORD_RE.test(_apiFn) && (_apiLn || !enriched.lastName)) {
    enriched.firstName = _apiFn;
  }
  if (_apiLn && !_UI_WORD_RE.test(_apiLn)) enriched.lastName = _apiLn;

  // ── Рятуємо одиничне DOM-слово від втрати ──────────────
  // DOM показав 1 слово, а API дав інше слово в одному з полів — DOM-слово ставимо в порожнє поле
  if (_domSingleWord) {
    if (enriched.firstName && !enriched.lastName && enriched.firstName !== _domSingleWord) {
      enriched.lastName = _domSingleWord;
    } else if (enriched.lastName && !enriched.firstName && enriched.lastName !== _domSingleWord) {
      enriched.firstName = _domSingleWord;
    }
  }

  // Прибираємо дублікат якщо обидва поля = одне і те саме слово
  // Це означає що API і DOM не зійшлися щодо порядку (Last/First):
  //   DOM: "Omeiza Zainab" → parseNameParts (укр конвенція): lastName="Omeiza", firstName="Zainab"
  //   API: firstName="Omeiza" → перезаписало "Zainab", lastName залишився "Omeiza" → дублікат
  // Рятуємо ІНШЕ DOM-слово (Zainab) як lastName щоб не втратити його
  if (enriched.firstName && enriched.firstName === enriched.lastName) {
    if (info.firstName && info.firstName !== enriched.firstName) {
      enriched.lastName = info.firstName; // "Zainab" з оригінального parseNameParts.firstName
    } else if (info.lastName && info.lastName !== enriched.firstName) {
      enriched.lastName = info.lastName;
    } else {
      // Жодного альтернативного слова — просто очищуємо дублікат
      enriched.lastName = '';
    }
  }

  // Phone — всі відомі формати robota.ua API
  const phone =
    d.contactInfo?.phone?.phoneNumber ||
    d.contactInfo?.phones?.[0]?.phoneNumber ||
    d.contactInfo?.phones?.[0]?.number ||
    d.contactInfo?.phone ||
    d.phones?.[0]?.phoneNumber ||
    d.phones?.[0]?.number ||
    (typeof d.phones?.[0] === 'string' ? d.phones[0] : '') ||
    d.phone ||
    d.phoneNumber ||
    d.mobilePhone ||
    d.mobile ||
    d.contacts?.phone ||
    d.contacts?.mobilePhone ||
    '';
  // Нормалізуємо формат телефону (apply/list повертає "0686317188" → "+380686317188")
  if (phone) enriched.phone = ttNormalizePhone(phone);

  // Email — всі відомі формати robota.ua API
  // eMail (capital M) — формат з apply/list та /apply/view відповідей
  const email =
    d.contactInfo?.email ||
    d.contactInfo?.emails?.[0]?.value ||
    d.contactInfo?.emails?.[0] ||
    (typeof d.emails?.[0] === 'string' ? d.emails[0] : '') ||
    d.emails?.[0]?.value ||
    d.email || d.eMail ||
    d.emailAddress ||
    d.contacts?.email ||
    '';
  if (email && ttIsRealEmail(email)) enriched.email = String(email);

  // Photo
  if (d.photoUrl && d.photoUrl.startsWith('http')) enriched.picture = d.photoUrl;
  if (d.photo    && d.photo.startsWith('http'))    enriched.picture = d.photo;

  // City
  if (d.cityName) enriched.city = d.cityName;
  if (d.city)     enriched.city = d.city;

  // Resume PDF URL — якщо API повертає посилання на файл
  // resumeFile — новий тип "File" (API 2025): resumeType="Notepad" + поле resumeFile з мета-даними
  const _resumeFileObj = d.resumeFile || d._resumeFile;
  const _resumeFileUrl = _resumeFileObj?.url || _resumeFileObj?.fileUrl
                      || _resumeFileObj?.downloadUrl || _resumeFileObj?.path || '';
  const rUrl = d.pdfUrl || d.downloadUrl || d.resumeUrl || d.fileUrl || _resumeFileUrl || '';
  if (rUrl && rUrl.startsWith('http')) enriched.resumeUrl = rUrl;
  // Ім'я файлу з resumeFile (показується в кнопці завантаження)
  if (_resumeFileObj && !enriched.originalFileName) {
    const _rfn = _resumeFileObj.fileName || _resumeFileObj.name || _resumeFileObj.originalName || '';
    if (_rfn) enriched.originalFileName = _rfn;
  }

  // Resume text — форматуємо JSON-дані в текст для cover-letter
  if (!enriched.resumeText) {
    // Діагностика: показуємо доступні поля резюме в консолі для налагодження
    console.log('[TT] formatResumeText поля:', Object.keys(d).filter(k =>
      ['experience','experiences','workExperience','workExperiences','expiriences',
       'jobs','career','education','educations','skills','languages','about','summary',
       'salary','desiredSalary','position','skillsSummary'].includes(k)
    ).join(', ') || '(жодного з очікуваних)');
    const resumeBody = formatResumeText(d);

    // Covering letter text — окремий текст відгуку (coveringLetterExists=true у apply/list)
    // Завантажується через GET /apply/{id} та зберігається як _letterText на cached item
    const letterText = stripHtml(
      d._letterText || d.letter || d.coveringLetter || d.coveringLetterText || d.letterText || ''
    );

    if (letterText && resumeBody) {
      enriched.resumeText = `📝 Супровідний лист:\n${letterText}\n\n${'─'.repeat(40)}\n\n${resumeBody}`;
    } else if (letterText) {
      enriched.resumeText = letterText;
    } else if (resumeBody) {
      enriched.resumeText = resumeBody;
    }
  }

  // Мета для кнопки завантаження файлу резюме (robota.ua)
  if (apiData._numericApplyId)    enriched.numericApplyId    = apiData._numericApplyId;
  if (apiData._strApplyId)        enriched.strApplyId        = apiData._strApplyId;
  if (apiData._resumeType)        enriched.resumeType        = apiData._resumeType;
  if (apiData._resumeId)          enriched.resumeId          = apiData._resumeId;
  if (apiData._originalFileName)  enriched.originalFileName  = apiData._originalFileName;
  // Fallback: дані також можуть бути в самому об'єкті
  if (!enriched.resumeType && (d.resumeType || d.resume_type)) {
    enriched.resumeType = d.resumeType || d.resume_type;
  }
  // Fallback resumeId з кешованого apply-item (якщо _resumeId не встановлено)
  if (!enriched.resumeId) {
    const rId = d?.resumeId || d?.resume_id || d?.ResumeId || '';
    if (rId && String(rId) !== '0') enriched.resumeId = String(rId);
  }

  return enriched;
}

// Хелпер: встановлює тултіп з посиланням без пробивання кліків на сторінку
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

// ── Створити badge ─────────────────────────────────────────
function createBadgeWrap(cardId) {
  const wrap = document.createElement('div');
  wrap.className = 'tt-badge-wrap'; // позиція та стилі — в badges.css
  // BUG-16: зберігаємо cardId щоб bulkImport міг знайти .tt-dot після імпорту
  if (cardId) wrap.dataset.cardId = String(cardId);

  const cb = document.createElement('div');
  cb.className = 'tt-checkbox';
  if (selected.has(cardId)) cb.classList.add('checked');
  cb.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    selected.has(cardId) ? (selected.delete(cardId), cb.classList.remove('checked'))
                         : (selected.add(cardId), cb.classList.add('checked'));
    updateBulkBar();
  });
  wrap.appendChild(cb);

  const dot = document.createElement('div');
  dot.className = 'tt-dot loading';
  const tooltip = document.createElement('div');
  tooltip.className = 'tt-tooltip';
  tooltip.textContent = '⏳ Перевіряю...';
  dot.appendChild(tooltip);
  wrap.appendChild(dot);

  return { wrap, dot, tooltip, cb };
}

// ── Застосувати стан до значка ─────────────────────────────
function applyBadgeState(dot, tooltip, wrap, status, ttData, info) {
  dot.className = `tt-dot ${status}`;

  if (status === 'green')        tooltip.textContent = '✅ Немає в Teamtailor';
  else if (status === 'red')     _setTooltipDupe(tooltip, '🔴', 'Є в TT', ttData?.url, ttData?.name);
  else if (status === 'orange')  _setTooltipDupe(tooltip, '🟠', 'Дані різняться', ttData?.url, ttData?.name);
  else if (status === 'loading') { tooltip.textContent = '⏳ Перевіряю...'; return; }
  else                           tooltip.textContent = '⚠️ Помилка перевірки';

  // Remove any previously appended action button/link
  wrap.querySelectorAll('.tt-btn').forEach(el => el.remove());

  // 🔄 Кнопка ручного ре-чеку — для red/orange (видалили з TT → можна скинути кеш одразу)
  if (status === 'red' || status === 'orange') {
    const _rcCardId = wrap.dataset.cardId;
    const _rcBtn = document.createElement('button');
    _rcBtn.type = 'button'; _rcBtn.textContent = '🔄'; _rcBtn.title = 'Перевірити знову';
    _rcBtn.style.cssText = 'background:none;border:none;color:#74b9ff;cursor:pointer;font-size:11px;padding:0 0 0 6px;line-height:1;vertical-align:middle;';
    _rcBtn.addEventListener('click', async e => {
      e.stopPropagation(); e.preventDefault();
      if (!_rcCardId) return;
      const _cc = checkCache.get(_rcCardId);
      const _ph = _cc?._badgePhone || ''; const _em = _cc?._badgeEmail || '';
      const _nm = `${info?.firstName || ''} ${info?.lastName || ''}`.trim() || info?.fullName || '';
      dot.className = 'tt-dot loading'; tooltip.textContent = '⏳ Перевіряю...';
      try {
        const _r = await bgMsg({ type: 'CHECK_DUPLICATE', phone: _ph, email: _em, name: _nm });
        if (!_r) { dot.className = `tt-dot ${status}`; return; }
        if (!_r.dupe) {
          chrome.storage.local.remove(_dupeKey(_rcCardId));
          checkCache.set(_rcCardId, { ..._cc, status: 'green', ttData: null });
          applyBadgeState(dot, tooltip, wrap, 'green', null, info);
        } else {
          chrome.storage.local.set({ [_dupeKey(_rcCardId)]: { status: 'red', ttData: _r.dupe, ts: Date.now(), ttl: _DUPE_TTL_MS, hadContacts: !!(_ph || _em) } });
          checkCache.set(_rcCardId, { ..._cc, status: 'red', ttData: _r.dupe });
          applyBadgeState(dot, tooltip, wrap, 'red', _r.dupe, info);
        }
      } catch (_) { dot.className = `tt-dot ${status}`; }
    });
    tooltip.appendChild(_rcBtn);
  }

  if (status === 'red') {
    if (ttData?.url) {
      const link = document.createElement('a');
      link.href = ttData.url;
      link.target = '_blank';
      link.className = 'tt-btn';
      link.style.textDecoration = 'none';
      link.textContent = '↗ TT';
      link.addEventListener('click', e => e.stopPropagation());
      wrap.appendChild(link);
    }
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-btn' + (status === 'orange' ? ' update' : '');
    btn.textContent = status === 'orange' ? '↺ TT' : '+TT';
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      btn.textContent = '⏳';
      btn.disabled = true;

      // UUID Interaction: якщо preloadApplyList вже завершено — оновлюємо UUID→numericId за іменем
      // (до цього моменту nameApplyIdMap гарантовано заповнений, гонка виключена)
      const _cStrip = String(info.applyId || '').replace(/-[a-z][a-z]*$/i, '');
      if (/^[0-9a-f]{32}$/i.test(_cStrip) && !numericApplyIdMap.has(_cStrip) && info.fullName) {
        const _cnk = (info.fullName || '').toLowerCase().replace(/\s+/g, ' ');
        // 🔍 Діагностика: показуємо що шукаємо і що є в nameApplyIdMap
        console.log('[TT] [click] UUID-пошук по імені:', JSON.stringify(_cnk));
        console.log('[TT] [click] nameApplyIdMap:', nameApplyIdMap.size, 'записів. Зразки:',
          [...nameApplyIdMap.keys()].slice(0, 5).map(k => JSON.stringify(k)).join(', '));
        if (nameApplyIdMap.has(_cnk)) {
          const { numericId: _cnid, item: _cni } = nameApplyIdMap.get(_cnk);
          applyCache.set(info.applyId, _cni);
          applyCache.set(_cStrip, _cni);
          numericApplyIdMap.set(info.applyId, _cnid);
          numericApplyIdMap.set(_cStrip, _cnid);
          if (_cni.resumeId) {
            resumeIdMap.set(info.applyId, String(_cni.resumeId));
            resumeIdMap.set(_cStrip, String(_cni.resumeId));
          }
          console.log('[TT] [click] UUID→numericId за іменем:', _cnk.substring(0, 25), '→', _cnid);
        } else {
          // Пробуємо часткове співпадіння (перші 2 слова, на випадок розбіжності по-батькові або порядку)
          const _cnkParts = _cnk.split(' ');
          const _cnkShort = _cnkParts.slice(0, 2).join(' ');
          let _fallback = null;
          for (const [k, v] of nameApplyIdMap) {
            const kParts = k.split(' ');
            const kShort = kParts.slice(0, 2).join(' ');
            // Перші 2 слова збігаються АБО зворотний порядок
            if (kShort === _cnkShort || (kParts.length >= 2 && kParts[0] === _cnkParts[1] && kParts[1] === _cnkParts[0])) {
              _fallback = { k, v };
              break;
            }
          }
          if (_fallback) {
            const { numericId: _cnid, item: _cni } = _fallback.v;
            applyCache.set(info.applyId, _cni);
            applyCache.set(_cStrip, _cni);
            numericApplyIdMap.set(info.applyId, _cnid);
            numericApplyIdMap.set(_cStrip, _cnid);
            if (_cni.resumeId) {
              resumeIdMap.set(info.applyId, String(_cni.resumeId));
              resumeIdMap.set(_cStrip, String(_cni.resumeId));
            }
            console.log('[TT] [click] UUID→numericId часткове:', JSON.stringify(_fallback.k), '→', _cnid);
          } else {
            console.log('[TT] [click] UUID-кандидат не знайдений в nameApplyIdMap. Ім\'я DOM:', JSON.stringify(_cnk));
          }
        }
      }

      const fullData = await getFullCandidateData(info.applyId);
      const enriched = enrichInfo(info, fullData);
      console.log('[TT] → modal phone:', enriched.phone || '(порожньо)', '| email:', enriched.email || '(порожньо)');

      btn.textContent = status === 'orange' ? '↺ TT' : '+TT';
      btn.disabled = false;

      // Callback після успішного імпорту/оновлення — оновлює значок картки
      const onImported = (result) => {
        const cId = result?.candidateId || '';
        const newTtData = cId ? {
          id:    cId,
          name:  `${enriched.firstName || ''} ${enriched.lastName || ''}`.trim() || enriched.fullName || '',
          url:   result.url || `https://app.teamtailor.com/candidates/${cId}`,
          email: enriched.email || '',
          phone: enriched.phone || ''
        } : null;
        const cardId = info.applyId || info.fullName;
        persistDupe(cardId, 'red', newTtData);
        checkCache.set(cardId, { status: 'red', ttData: newTtData, info: enriched });
        applyBadgeState(dot, tooltip, wrap, 'red', newTtData, enriched);
      };

      // ── Перевірка дублів перед відкриттям модалки ──────────
      // Для orange — дубль вже відомий (ttData є); для green — перевіряємо з реальними контактами.
      let knownDupe = (status === 'orange' || status === 'red') ? ttData : null;
      if (!knownDupe && (enriched.phone || enriched.email)) {
        try {
          const dupeResp = await bgMsg({
            type:  'CHECK_DUPLICATE',
            phone: enriched.phone || '',
            email: enriched.email || '',
            name:  `${enriched.firstName} ${enriched.lastName}`.trim()
          });
          if (dupeResp?.dupe) knownDupe = dupeResp.dupe;
        } catch (_) {}
      }

      if (knownDupe) {
        // Оновлюємо бейдж негайно — дубль підтверджений через контакти/ім'я
        // (навіть якщо користувач скасує імпорт, значок лишиться червоним)
        const _dupeCardId = info.applyId || info.fullName;
        persistDupe(_dupeCardId, 'red', knownDupe);
        checkCache.set(_dupeCardId, { status: 'red', ttData: knownDupe, info: enriched });
        applyBadgeState(dot, tooltip, wrap, 'red', knownDupe, enriched);

        openDupePopup(
          knownDupe,
          enriched,
          () => openImportModal(enriched, status, onImported),   // «Все одно додати»
          onImported                                              // «Оновити профіль» → та сама callback
        );
      } else {
        openImportModal(enriched, status, onImported);
      }
    });
    wrap.appendChild(btn);
  }
}

// ── Персистентний кеш статусів бейджів ────────────────────
// Зберігаємо усі статуси між перезавантаженнями, щоб не викликати TT API повторно.
// TTL залежить від статусу:
//   red/orange  → 48 год  (підтверджений дубль — рідко змінюється)
//   green+контакти → 2 год (перевірений за phone/email — досить надійно)
//   green+тільки ім'я → 30 хв (менш надійно — частіше перевіряємо)
const _DUPE_TTL_MS        = 48 * 60 * 60 * 1000;
const _GREEN_CONTACT_TTL  =  2 * 60 * 60 * 1000; // 2 год якщо є phone/email
const _GREEN_NAME_TTL     = 30 * 60 * 1000;       // 30 хв якщо тільки ім'я

function _dupeKey(cardId) {
  return ('tt_dupe_' + String(cardId || '')).substring(0, 128);
}

// hasContacts: true якщо перевірка мала phone або email (надійніший green)
function persistDupe(cardId, status, ttData, hasContacts = false) {
  if (!cardId || status === 'grey') return;
  const ttl = status === 'green'
    ? (hasContacts ? _GREEN_CONTACT_TTL : _GREEN_NAME_TTL)
    : _DUPE_TTL_MS;
  try {
    chrome.storage.local.set({
      [_dupeKey(cardId)]: { status, ttData: ttData || null, ts: Date.now(), ttl, hadContacts: !!hasContacts }
    });
  } catch (_) {}
}

async function loadPersistedDupe(cardId) {
  if (!cardId) return null;
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(_dupeKey(cardId), result => {
        const entry = result[_dupeKey(cardId)];
        if (!entry || !entry.ts) { resolve(null); return; }
        // TTL береться з самого запису (підтримка старих записів без ttl-поля)
        const entryTtl = entry.ttl || _DUPE_TTL_MS;
        if (Date.now() - entry.ts > entryTtl) {
          chrome.storage.local.remove(_dupeKey(cardId));
          resolve(null); return;
        }
        resolve(entry);
      });
    } catch (_) { resolve(null); }
  });
}

// ── Обробка картки ─────────────────────────────────────────
async function processCard(card) {
  if (card.dataset.ttProcessed) return;
  card.dataset.ttProcessed = '1';
  card.style.position = 'relative';

  const info   = extractFromCard(card);
  // Нормалізуємо cardId: знімаємо URL-суфікси robota.ua (-attach, -interaction тощо).
  // Angular може ре-рендерити картку з іншим суфіксом (12345 → 12345-attach), що призводило
  // до розриву між selected Set (старий id) і checkCache (новий id) — bulk import пропускав картки.
  // info.applyId зберігається як є в info — getFullCandidateData потребує суфікс для resumeType.
  const cardId = ((info.applyId || '').replace(/-[a-z][a-z]*$/i, '') || info.fullName);
  if (!info.fullName || info.fullName.length < 3) return;

  const { wrap, dot, tooltip } = createBadgeWrap(cardId);
  card.appendChild(wrap);

  // If we already know the status (card re-rendered by Angular) — instant paint
  if (checkCache.has(cardId)) {
    const { status, ttData } = checkCache.get(cardId);
    applyBadgeState(dot, tooltip, wrap, status, ttData, info);
    return;
  }

  // Позначаємо 'loading' в checkCache одразу — bulkImport може чекати на цей стан
  // (якщо користувач натисне bulk import поки цей processCard ще в черзі семафору)
  checkCache.set(cardId, { status: 'loading', ttData: null, info });

  // Беремо телефон/email із preload-кешу (безкоштовно — дані вже є в пам'яті).
  // Це дозволяє знайти дубля за телефоном навіть без відкриття панелі деталей.
  const _bStrip = (info.applyId || '').replace(/-[a-z][a-z]*$/i, '');
  const _bCi    = applyCache.get(info.applyId) || applyCache.get(_bStrip);
  const _bCd    = _bCi?.data || _bCi;
  const badgePhone = _bCd?.phone || _bCd?.contactInfo?.phone?.phoneNumber || _bCd?.phoneNumber || '';
  const badgeEmail = _bCd?.email || _bCd?.contactInfo?.email || _bCd?.emailAddress || '';

  // ── Відновлюємо з персистентного кешу (між перезавантаженнями) ──
  // Green entries expire швидко → одразу повертаємо (ре-чек зайвий).
  // Red/orange: показуємо кешований бейдж одразу, потім blocking re-check
  // щоб виявити кандидатів видалених з TT (без race condition з bulkImport).
  const persisted = await loadPersistedDupe(cardId);
  if (persisted?.status === 'green' && persisted.hadContacts) {
    // Перевірка була з phone/email — надійний результат, довіряємо кешу
    checkCache.set(cardId, { status: 'green', ttData: null, info, _badgePhone: badgePhone, _badgeEmail: badgeEmail });
    applyBadgeState(dot, tooltip, wrap, 'green', null, info);
    return;
  }
  if (persisted) {
    // Одразу показуємо кешований статус (UX: бейдж без затримки)
    checkCache.set(cardId, { status: persisted.status, ttData: persisted.ttData, info, _badgePhone: badgePhone, _badgeEmail: badgeEmail });
    applyBadgeState(dot, tooltip, wrap, persisted.status, persisted.ttData, info);
    // Продовжуємо до blocking CHECK_DUPLICATE:
    // - red/orange: перевіряємо чи кандидата ще в TT
    // - green name-only (hadContacts=false): перевіряємо чи не зʼявився дубль
  }

  const _hadContacts = !!(badgePhone || badgeEmail);

  const _fn = info.firstName || '';
  const _ln = info.lastName  || '';
  const _nameOrder1 = [_fn, _ln].filter(Boolean).join(' ');

  // Показуємо loading тільки якщо немає persisted бейджа (інакше залишаємо red/orange)
  if (!persisted) applyBadgeState(dot, tooltip, wrap, 'loading', null, info);

  let status = 'green';
  let ttData = null;
  try {
    const resp = await Promise.race([
      bgMsg({ type: 'CHECK_DUPLICATE', phone: badgePhone, email: badgeEmail, name: _nameOrder1 }),
      new Promise(r => setTimeout(() => r(null), 8000))
    ]);
    if (resp?.dupe) {
      ttData = resp.dupe;
      status = 'red';
      try {
        const cmpResp = await Promise.race([
          bgMsg({ type: 'COMPARE_WITH_TT', ttId: resp.dupe.id, candidate: { phone: badgePhone, email: badgeEmail } }),
          new Promise(r => setTimeout(() => r(null), 6000))
        ]);
        if (cmpResp?.result?.hasDiffs) status = 'orange';
      } catch (_) {}
    }
  } catch (e) { status = 'grey'; }

  persistDupe(cardId, status, ttData, _hadContacts);
  checkCache.set(cardId, { status, ttData, info, _badgePhone: badgePhone, _badgeEmail: badgeEmail });
  applyBadgeState(dot, tooltip, wrap, status, ttData, info);
}

// ── Утиліти для роботи з Shadow DOM ───────────────────────
// Angular Emulated encapsulation НЕ використовує Shadow DOM,
// але деякі компоненти robota.ua можуть. Ці функції рекурсивно
// обходять shadow roots, щоб знайти текст/елементи.
function extractShadowText(root) {
  if (!root) return '';
  let text = root.textContent || '';
  try {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) text += ' ' + extractShadowText(el.shadowRoot);
    });
  } catch (_) {}
  return text;
}

function deepQueryAll(root, selector) {
  if (!root) return [];
  const results = [];
  try {
    results.push(...root.querySelectorAll(selector));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
    });
  } catch (_) {}
  return results;
}

// ── Витягнути контакти і ім'я напряму з DOM панелі ────────
function extractFromPanel(panel) {
  // ── Телефон: tel:-посилання (включаючи Shadow DOM) → текст-fallback ───
  let phone = '';
  const telLinks = deepQueryAll(panel, 'a[href^="tel:"]');
  if (telLinks.length) {
    phone = telLinks[0].href.replace('tel:', '').replace(/[^\d+]/g, '');
    if (phone && !phone.startsWith('+')) phone = '+' + phone;
  }
  if (!phone) {
    // Витягуємо телефон навіть якщо він відформатований: +38 (068) 227 - 20 - 87
    // Спочатку пробуємо суворий regex (є +38 або 380 префікс):
    const allText = extractShadowText(panel);
    const pm = allText.match(
      /(?:(?:\+?38)[\s-]*)?\(?(0\d{2})\)?[\s-.]*(\d{3})[\s-.]*(\d{2})[\s-.]*(\d{2})\b/
    );
    if (pm) {
      phone = '+38' + pm[1] + pm[2] + pm[3] + pm[4];
    }
  }

  // ── Email: mailto:-посилання (включаючи Shadow DOM) → текст-fallback ──
  let email = '';
  const mailLinks = deepQueryAll(panel, 'a[href^="mailto:"]');
  if (mailLinks.length) {
    email = mailLinks[0].href.replace('mailto:', '').split('?')[0].trim();
  }
  if (!email) {
    const allText = extractShadowText(panel);
    const m = allText.match(/[\w.+\-]+@[\w\-]+\.[\w.]+/);
    if (m && ttIsRealEmail(m[0])) email = m[0];
  }

  // ── Ім'я: 3 стратегії ──────────────────────────────────
  let nameText = '';

  // Стратегія А: конкретні селектори (robota.ua класи)
  const nameSels = [
    '[class*="resume-full-name"]', '[class*="resume-name"]',
    '[class*="candidate-name"]',   '[class*="full-name"]',
    '[class*="fullName"]',         '[class*="applicant-name"]',
    '[data-qa="resume-serp-name"]','[data-qa="candidate-name"]',
  ];
  // Хелпер: looksLikeName АБО 1 кириличне слово (приватний режим: "Юрій", "Олег")
  const _looksLikeNameOrSingle = (txt) => {
    if (!txt || /\d/.test(txt) || !/^[А-ЯҐЄІЇA-Z]/.test(txt)) return false;
    if (looksLikeName(txt)) return true;
    return /^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(txt) && !_UI_WORD_RE.test(txt);
  };

  for (const sel of nameSels) {
    const el = panel.querySelector(sel);
    if (!el) continue;
    const txt = el.textContent?.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');
    if (_looksLikeNameOrSingle(txt)) { nameText = txt; break; }
  }

  // Стратегія А.2: santahighlighter — robota.ua маркує цим атрибутом поле ПІБ.
  // Перевіряємо всі елементи з цим атрибутом; телефон/email не пройдуть looksLikeName.
  // Важливо: до Стратегії Б, яка може знайти "Air Wizz" (назву роботодавця) раніше за ПІБ.
  if (!nameText) {
    for (const el of panel.querySelectorAll('[santahighlighter]')) {
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (_looksLikeNameOrSingle(txt)) { nameText = txt; break; }
    }
  }

  // Стратегія А.3: h1/h2/h3 у панелі (standalone /candidates/{id} — ім'я у заголовку)
  if (!nameText) {
    for (const el of panel.querySelectorAll('h1, h2, h3')) {
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').split('\n')[0].trim();
      if (_looksLikeNameOrSingle(txt)) { nameText = txt; break; }
    }
  }

  // Стратегія Б: скануємо ВСІ елементи панелі з невеликою кількістю дітей
  // (великі контейнери відкидаємо, шукаємо компактний елемент чий текст = ПІБ)
  if (!nameText) {
    for (const el of panel.querySelectorAll('*')) {
      if (['SCRIPT','STYLE','BUTTON','A','SELECT','INPUT','TEXTAREA'].includes(el.tagName)) continue;
      if (el.children.length > 6) continue;
      const txt = el.textContent?.trim().replace(/[\n\t]+/g, ' ').replace(/\s+/g, ' ');
      if (looksLikeName(txt)) { nameText = txt; break; }
    }
  }

  // Стратегія В: склеюємо сусідні листові елементи що починаються з ВЕЛИКОЇ літери
  // (ім'я розбите по окремих <span>: "Карпусенко" / "Кирило" / "Олексійович")
  if (!nameText) {
    const leaves = [...panel.querySelectorAll('span, div, p, strong, b')]
      // Пропускаємо листові елементи всередині кнопок/посилань: "Завантажити", "Поскаржитися"
      .filter(el => el.children.length === 0 && !el.closest('button, a') && /^[А-ЯҐЄІЇA-Z]/.test(el.textContent?.trim() || ''));
    for (let i = 0; i < leaves.length - 1; i++) {
      const words = leaves.slice(i, i + 3).map(n => n.textContent?.trim()).filter(Boolean);
      const combined = words.join(' ');
      if (looksLikeName(combined)) { nameText = combined; break; }
    }
  }

  // ── Фото ───────────────────────────────────────────────
  // Шукаємо фото профілю: спочатку CDN robota.ua (cv-photos*), потім будь-яке зображення
  // що НЕ є іконкою месенджера (Telegram, Viber тощо).
  const imgEl = panel.querySelector('img[src*="cv-photos"]')
             || panel.querySelector('img[src*="robota.ua"][src*=".jpg"], img[src*="robota.ua"][src*=".png"], img[src*="robota.ua"][src*=".webp"]')
             || [...panel.querySelectorAll('img[src*="http"], img[src*="//"]')]
                  .find(img => !img.closest('a[href*="t.me"], a[href*="telegram"], a[href*="viber"], a[href*="tg:"]')
                            && !img.src.includes('telegram') && !img.src.includes('viber'));
  const picture = imgEl?.src?.startsWith('http') ? imgEl.src : '';

  return { nameText, phone, email, picture };
}

// ── Блокування навігації між кандидатами під час імпорту ──
// (Cleverstaff pattern) Натискання стрілок навігації під час API-виклику
// призводить до race condition. Блокуємо pointerEvents на max 10с.
function _lockCandidateNav(lock) {
  const nav = document.querySelector('lib-candidate-navigation');
  if (!nav) return;
  if (lock) {
    nav.style.pointerEvents = 'none';
    // Авто-розблокування на випадок якщо щось пішло не так (помилка, таймаут)
    setTimeout(() => { nav.style.pointerEvents = ''; }, 10000);
  } else {
    nav.style.pointerEvents = '';
  }
}

// ── Кнопка в деталях (права панель) ───────────────────────
function addDetailButton(panel) {
  if (panel.dataset.ttBtn) return;
  panel.dataset.ttBtn = '1';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tt-btn';
  btn.style.cssText = 'margin:8px 0 0 8px;font-size:11px;padding:5px 12px;';
  btn.textContent = '+ Додати в Teamtailor';

  btn.addEventListener('click', async () => {
    btn.textContent = '⏳ Завантажую...';
    btn.disabled = true;

    // applyId читаємо в момент кліку — Angular може оновити URL між рендерами
    // Формат А: ?id=98516070-attach  (список кандидатів із панеллю)
    // Формат Б: /candidates/23514700 (пряма сторінка профілю)
    // Формат В: /my/cvdb/12345678   (індивідуальне резюме з бази CVDB)
    const urlMatch = location.href.match(/[?&]id=([^&\s#]+)/i)
                  || location.href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i)
                  || location.href.match(/\/my\/cvdb\/(\d{5,})(?:[/?#]|$)/i);
    const applyId  = urlMatch ? urlMatch[1] : '';
    // Для прямого профілю — реєструємо candidateId як resumeId щоб GET_ROBOTA_RESUME спрацював
    if (applyId && /^\d{6,}$/.test(applyId) && !resumeIdMap.has(applyId)) {
      resumeIdMap.set(applyId, applyId);
    }
    // Для прямого профілю/CVDB — якщо немає кешу з resumeType, ставимо 'Selected'
    // (числовий ID у URL = ID резюме з бази robota.ua → getfile підтримує resumeType=Selected)
    if (applyId && /^\d{6,}$/.test(applyId) && !applyCache.has(applyId)) {
      applyCache.set(applyId, {
        _resumeType:     'Selected',
        _numericApplyId: applyId,
        _resumeId:       applyId,
        _strApplyId:     applyId
      });
    }

    // ── 1. Витягуємо контакти і ім'я напряму з DOM ────────
    // Re-query панелі в момент кліку (уникаємо stale reference після Angular re-render).
    // split-view панель АБО standalone профіль (знаходимо за "Запропонувати вакансію")
    const _standAlone = !document.querySelector('alliance-employer-candidates-candidate-panel-desktop')
      ? ([...document.querySelectorAll('button, a')].find(
          el => !el.closest('nav, header') && (el.textContent || '').trim().includes('Запропонувати вакансію')
        )?.closest('aside, section, [class*="sidebar"], [class*="actions"], [class*="contact"]')
        || null)
      : null;
    const livePanel = document.querySelector('alliance-employer-candidates-candidate-panel-desktop')
                   || _standAlone || panel;
    const { nameText: domName, phone: domPhone, email: domEmail, picture: domPic } = extractFromPanel(livePanel);

    // ── 2. applyCache → авторитетне ім'я (ПРІОРИТЕТ над DOM) ──
    // DOM може знайти назву компанії/посади замість прізвища кандидата.
    // Кеш (з apply/list або spy-перехоплення) завжди містить реальне ПІБ.
    // Стрипаємо БУДЬ-ЯКИЙ буквений суфікс: -offered, -interaction, -attach, -cv, ...
    let nameText = '';
    if (applyId) {
      const stripped = applyId.replace(/-[a-z][a-z]*$/i, '');
      const ci = applyCache.get(applyId) || applyCache.get(stripped);
      if (ci) {
        const d = ci?.data || ci;
        const ln  = d?.name?.lastName  || d?.lastName  || '';
        const fn  = d?.name?.firstName || d?.firstName || '';
        const raw = d?.fullName || d?.full_name
                 || (typeof d?.name === 'string' ? d.name : '') || '';
        const fromCache = (ln && fn) ? `${ln} ${fn}`.trim() : (raw || `${ln}${fn}`.trim());
        // Пріоритет кешу тільки якщо є структуровані поля firstName+lastName (надійно).
        // Якщо кеш має лише рядок d.name (може бути назва компанії/роботодавця — "Air Wizz"),
        // і DOM вже дав правильне ім'я — залишаємо DOM.
        const hasStructuredName = !!(ln && fn);
        if (looksLikeName(fromCache) && (hasStructuredName || !looksLikeName(domName))) {
          nameText = fromCache;
        }
      }
    }
    // Якщо кеш не дав імені — використовуємо DOM (може бути неточним)
    if (!nameText) nameText = domName;

    // Перевірка: чи nameText вже містить одне достовірне ім'я (приватний профіль → "Олександр")
    // Якщо так — НЕ перезаписуємо checkCache-даними (що могли витягнути назву міста чи посаду з картки)
    const _nameIsPartialValid = !!nameText
      && /^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(nameText)
      && !_UI_WORD_RE.test(nameText)
      && !/ти(ся)?$|ться$/i.test(nameText);

    // Fallback 1: якщо ні кеш, ні DOM не дали 2-словного імені —
    // checkCache містить info з processCard/extractFromCard (надійно витягує ім'я з картки списку)
    // АЛЕ: якщо nameText вже є одне достовірне слово (приватний профіль) — пропускаємо checkCache
    if (!looksLikeName(nameText) && !_nameIsPartialValid) {
      const _stripped2 = (applyId || '').replace(/-[a-z][a-z]*$/i, '');
      for (const _cid of [applyId, _stripped2].filter(Boolean)) {
        const _cc = checkCache.get(_cid);
        if (!_cc?.info) continue;
        const _ccFull = `${_cc.info.lastName || ''} ${_cc.info.firstName || ''}`.trim()
                     || _cc.info.fullName || '';
        if (looksLikeName(_ccFull)) { nameText = _ccFull; break; }
      }
    }

    // Fallback 2: standalone-сторінка профілю — панель може бути вузькою (лише кнопки).
    // Шукаємо ім'я по всьому документу: h1/h2, santa-typo-h*, відомі name-класи + strong/b.
    // Запускається навіть якщо вже є одне слово ("Анастасія") — щоб знайти повне ім'я.
    // Але перезаписує nameText лише якщо знайдено КРАЩЕ (багатослівне) ім'я.
    if (!looksLikeName(nameText) && (
          /\/candidates\/\d{6,}(?:[/?#]|$)/i.test(location.pathname) ||
          /\/my\/cvdb\/\d{5,}(?:[/?#]|$)/i.test(location.pathname)
        )) {
      // Допоміжна нормалізація ALL CAPS кирилиці:
      // "КОНОНОВА АНАСТАСІЯ ОЛЕГІВНА" → "Кононова Анастасія Олегівна"
      // Умова: є пробіл, немає малих літер, є хоч одна кирилична велика
      const _normCaps = s => {
        if (!s || !/\s/.test(s) || /[а-яґєіїa-z]/.test(s) || !/[А-ЯҐЄІЇІ]/.test(s)) return s;
        return s.split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
      };
      const _docEls = [...document.querySelectorAll(
        'h1, h2, h3, strong, b, ' +
        '[class*="santa-typo-h"], [class*="resume-full-name"], [class*="resume-name"], ' +
        '[class*="candidate-name"], [class*="full-name"], [class*="applicant-name"], ' +
        '[class*="fio"], [class*="person-name"], [class*="header-name"]'
      )].filter(el => !el.closest('nav, header, footer, button, a')
                   && el.children.length <= 3);  // уникаємо великих контейнерів
      for (const el of _docEls) {
        const _t = _normCaps((el.textContent || '').trim().split('\n')[0].trim().replace(/\s+/g, ' '));
        if (looksLikeName(_t)) {
          // Перезаписуємо навіть якщо є 1 слово — повне ім'я краще за часткове
          nameText = _t; break;
        }
        // Одне ім'я без прізвища (приватний режим) — лише якщо nameText ще порожній
        if (!nameText && /^[А-ЯҐЄІЇA-Z][а-яґєіїa-z'ʼ\-]{2,29}$/.test(_t) && !_UI_WORD_RE.test(_t) && !/ти(ся)?$|ться$/.test(_t)) {
          nameText = _t; break;
        }
      }
    }

    const { lastName, firstName } = parseNameParts(nameText || '');

    const basicInfo = {
      applyId,
      lastName, firstName,
      fullName:  nameText || '',
      phone:     domPhone,
      email:     domEmail,
      picture:   domPic,
      href:      location.href,
      vacancyId: getVacancyId()
    };

    // ── 3. API-збагачення (resumeText, краще фото, тощо) ──
    const fullData = await getFullCandidateData(applyId);
    const enriched = enrichInfo(basicInfo, fullData);

    // DOM-дані мають пріоритет якщо API їх не повернув
    if (!enriched.phone  && domPhone) enriched.phone  = domPhone;
    if (!enriched.email  && domEmail) enriched.email  = domEmail;
    if (!enriched.picture && domPic)  enriched.picture = domPic;
    // Ім'я з API доповнюється з DOM-nameText, але НЕ перезаписує наповнені поля
    if (!looksLikeName(`${enriched.firstName} ${enriched.lastName}`.trim()) && nameText) {
      const { lastName: _ln, firstName: _fn } = parseNameParts(nameText);
      // Якщо DOM дав 2 слова — використовуємо повний результат (перевага DOM-структуровано)
      if (_fn && _ln) {
        enriched.firstName = _fn;
        enriched.lastName  = _ln;
      } else {
        // DOM дав 1 слово — заповнюємо лише порожнє поле
        if (_fn && !enriched.firstName && _fn !== enriched.lastName)  enriched.firstName = _fn;
        if (_ln && !enriched.lastName  && _ln !== enriched.firstName) enriched.lastName  = _ln;
        // Якщо в parseNameParts слово потрапило у firstName (single-word convention),
        // але enriched.firstName вже заповнений API — кладемо це слово у lastName
        if (_fn && enriched.firstName && _fn !== enriched.firstName && !enriched.lastName) {
          enriched.lastName = _fn;
        }
      }
    }

    btn.textContent = '+ Додати в Teamtailor';
    btn.disabled = false;

    // ── Перевірка дублів перед відкриттям модалки ──────────
    let knownDupe = null;
    try {
      const dupeResp = await bgMsg({
        type:  'CHECK_DUPLICATE',
        phone: enriched.phone || '',
        email: enriched.email || '',
        name:  `${enriched.firstName} ${enriched.lastName}`.trim()
      });
      if (dupeResp?.dupe) knownDupe = dupeResp.dupe;
    } catch (_) {}

    if (knownDupe) {
      const cardId = applyId || enriched.fullName;
      // Зберігаємо дубль одразу — незалежно від вибору у попапі.
      // Наступне завантаження покаже червоний бейдж без нового API-запиту.
      persistDupe(cardId, 'red', knownDupe, !!(enriched.phone || enriched.email));
      checkCache.set(cardId, { status: 'red', ttData: knownDupe, info: enriched });
      const _knownDot = document.querySelector(`.tt-badge-wrap[data-card-id="${CSS.escape(cardId)}"] .tt-dot`);
      if (_knownDot) _knownDot.className = 'tt-dot red';
      openDupePopup(
        knownDupe,
        enriched,
        () => openImportModal(enriched, 'green'),                // «Все одно додати»
        (result) => {                                             // «Оновити профіль»
          const cId = result?.candidateId || '';
          if (cId && cardId) {
            const newTtData = {
              id:    cId,
              name:  `${enriched.firstName || ''} ${enriched.lastName || ''}`.trim(),
              url:   result.url || `https://app.teamtailor.com/candidates/${cId}`,
              email: enriched.email || '',
              phone: enriched.phone || ''
            };
            persistDupe(cardId, 'red', newTtData, true);
            checkCache.set(cardId, { status: 'red', ttData: newTtData, info: enriched });
          }
        }
      );
    } else {
      openImportModal(enriched, 'green');
    }
  });

  // Вставляємо кнопку на початку першої секції з контентом
  const firstContent = panel.querySelector(
    'alliance-employer-resume-experience, [class*="experience"], [class*="resume-content"], section, article'
  ) || panel.querySelector('div');
  if (firstContent) firstContent.prepend(btn);
  else panel.prepend(btn);
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
        '<button id="tt-bd-import" class="tt-btn" style="background:#e17055;justify-content:center;width:100%;">+ Все одно додати як нового</button>' +
        '<button id="tt-bd-remove" class="tt-btn-cancel" style="text-align:center;width:100%;">🗑 Видалити зі списку на імпорт</button>' +
        '<button id="tt-bd-cancel" class="tt-btn-cancel" style="text-align:center;width:100%;color:#d63031;border-color:#fab1a0;">🚫 Скасувати імпорт</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('#tt-bd-x'     ).addEventListener('click', () => { overlay.remove(); resolve('cancel'); });
    modal.querySelector('#tt-bd-update').addEventListener('click', () => { overlay.remove(); resolve('update'); });
    modal.querySelector('#tt-bd-import').addEventListener('click', () => { overlay.remove(); resolve('import');  });
    modal.querySelector('#tt-bd-remove').addEventListener('click', () => { overlay.remove(); resolve('remove');  });
    modal.querySelector('#tt-bd-cancel').addEventListener('click', () => { overlay.remove(); resolve('cancel');  });
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

async function bulkImport() {
  const ids = [...selected];
  bulkBar?.remove(); bulkBar = null;

  const progressEl = document.createElement('div');
  progressEl.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;z-index:99999;min-width:260px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);';
  document.body.appendChild(progressEl);

  // ── Фаза 1: збираємо дані (нічого не імпортується) ───────────
  // processCard запускається конкурентно (без await в processCards), тому деякі картки
  // можуть ще бути в черзі семафору коли користувач натискає bulk import.
  // Чекаємо до 15с поки кожна картка завершить CHECK_DUPLICATE.
  const plan = []; // [{id, name, enriched, cached, action:'import'|'update'|'skip', dupe}]
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let cached = checkCache.get(id);

    // Якщо checkCache ще не готовий — чекаємо (processCard ще в черзі семафору)
    if (!cached || cached.status === 'loading') {
      const _name0 = cached?.info?.firstName || id;
      progressEl.textContent = `⏳ Очікування перевірки: ${_name0}...`;
      for (let _w = 0; _w < 150 && (!cached || cached.status === 'loading'); _w++) {
        await new Promise(r => setTimeout(r, 100));
        cached = checkCache.get(id);
      }
    }
    if (!cached || cached.status === 'loading') continue; // таймаут 15с

    const name = `${cached.info.firstName} ${cached.info.lastName}`.trim() || cached.info.fullName || '';
    progressEl.textContent = `🔍 Завантаження ${i + 1}/${ids.length}: ${name}`;

    const fullData = await getFullCandidateData(cached.info.applyId);
    const enriched = enrichInfo(cached.info, fullData);

    let dupe = (cached.status === 'red' || cached.status === 'orange') ? cached.ttData : null;

    // Targeted re-check: якщо бейдж зелений без контактів (name-only check),
    // а тепер є phone/email з fullData → перевіряємо ще раз надійніше.
    if (!dupe && cached.status === 'green' && !cached._badgePhone && !cached._badgeEmail) {
      const _rePhone = enriched.phone || '';
      const _reEmail = enriched.email || '';
      if (_rePhone || _reEmail) {
        try {
          const _r = await bgMsg({ type: 'CHECK_DUPLICATE', phone: _rePhone, email: _reEmail, name });
          if (_r?.dupe) {
            dupe = _r.dupe;
            checkCache.set(id, { ...cached, status: 'red', ttData: dupe });
            const _bw = document.querySelector(`.tt-badge-wrap[data-card-id="${CSS.escape(id)}"]`);
            if (_bw) applyBadgeState(_bw.querySelector('.tt-dot'), _bw.querySelector('.tt-tooltip'), _bw, 'red', dupe, cached.info);
          }
        } catch (_) {}
      }
    }

    plan.push({ id, name, enriched, cached, action: 'import', dupe });
  }

  // ── Фаза 2: показуємо попередження про дублі (досі нічого не створено) ──
  for (const item of plan) {
    if (!item.dupe) continue;
    progressEl.textContent = `⚠️ Дубль: ${item.name} — очікую вибір...`;
    const choice = await askBulkDupeChoice(item.name, item.dupe);
    if (choice === 'cancel') {
      progressEl.remove();
      selected.clear();
      document.querySelectorAll('.tt-checkbox.checked').forEach(el => el.classList.remove('checked'));
      updateBulkBar();
      return; // нічого не імпортовано
    }
    if (choice === 'import') { item.action = 'import'; continue; }
    if (choice === 'remove') {
      item.action = 'skip';
      selected.delete(item.id);
      document.querySelector(`.tt-badge-wrap[data-card-id="${CSS.escape(item.id)}"] .tt-checkbox`)?.classList.remove('checked');
      continue;
    }
    item.action = 'update';
  }

  // ── Фаза 3: імпорт (тільки затверджені кандидати) ───────────
  const tags = ['robota.ua', ...(prefs.recruiter_tag ? [prefs.recruiter_tag] : [])];
  let count = 0;
  const importedCandidates = [];
  const toImport = plan.filter(p => p.action === 'import' || p.action === 'update');

  for (let i = 0; i < toImport.length; i++) {
    const { id, name, enriched, cached, action, dupe } = toImport[i];
    progressEl.textContent = `⏳ ${i + 1}/${toImport.length} — ${name}`;

    try {
      let resp;
      const _robotaUrl = enriched.numericApplyId
        ? `https://robota.ua/candidates/${enriched.numericApplyId}`
        : (enriched.href?.match(/\/candidates\/\d{6,}/) ? enriched.href : (enriched.href || location.href));

      if (action === 'update') {
        resp = await bgMsg({
          type:      'UPDATE_CANDIDATE',
          ttId:      dupe.id,
          candidate: { ...enriched, source: 'robota.ua', robotaUrl: _robotaUrl }
        });
      } else {
        resp = await bgMsg({ type: 'IMPORT_CANDIDATE', candidate: { ...enriched, source: 'robota.ua', robotaUrl: _robotaUrl, tags } });
      }

      const _bWrap = document.querySelector(`.tt-badge-wrap[data-card-id="${CSS.escape(id)}"]`);
      if (_bWrap) {
        const _bDot = _bWrap.querySelector('.tt-dot');
        const _bTip = _bWrap.querySelector('.tt-tooltip');
        const _bUrl = resp?.result?.url || '';
        if (_bDot) _bDot.className = 'tt-dot red';
        if (_bTip && _bUrl) _bTip.innerHTML = `🔴 Є в TT — <a href="${_ttSafeUrl(_bUrl)}" target="_blank">${_htmlEsc(name)}</a>`;
        _bWrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
        if (_bUrl) {
          const _bLink = document.createElement('a');
          _bLink.href = _bUrl; _bLink.target = '_blank';
          _bLink.className = 'tt-btn'; _bLink.style.textDecoration = 'none';
          _bLink.textContent = '↗ TT';
          _bLink.addEventListener('click', e => e.stopPropagation());
          _bWrap.appendChild(_bLink);
        }
      }

      const _bTtData = resp?.result?.url ? {
        id: String(resp.result?.candidateId || resp.result?.url?.split('/').pop() || ''),
        name, url: resp.result.url
      } : (dupe || cached.ttData || null);
      checkCache.set(id, { ...cached, status: 'red', ttData: _bTtData });
      if (_bTtData) persistDupe(id, 'red', _bTtData, true);
      if (resp?.result?.url) importedCandidates.push({ name, url: resp.result.url });
      count++;
    } catch (e) {
      console.warn('[TT] bulkImport помилка для', id, e);
    }

    await new Promise(r => setTimeout(r, 1200));
  }

  progressEl.remove();
  selected.clear();
  document.querySelectorAll('.tt-checkbox.checked').forEach(el => el.classList.remove('checked'));
  updateBulkBar();
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
// Показується ПЕРЕД відкриттям модалки імпорту щоб дати вибір:
//   • Оновити наявний профіль (PATCH /candidates/{id})
//   • Все одно додати як нового (→ openImportModal)
//   • Скасувати
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
          source:    'robota.ua',
          robotaUrl: enriched.numericApplyId
            ? `https://robota.ua/candidates/${enriched.numericApplyId}`
            : (enriched.href?.match(/\/candidates\/\d{6,}/) ? enriched.href : (enriched.href || location.href))
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

// ── Modal ──────────────────────────────────────────────────
function openImportModal(info, status, onImported = null) {
  const overlay = document.createElement('div');
  overlay.className = 'tt-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'tt-modal';

  const initTags = ['robota.ua', ...(prefs.recruiter_tag ? [prefs.recruiter_tag] : [])];
  const displayName = `${info.firstName} ${info.lastName}`.trim() || info.fullName || '';
  // BUG-04/19: попередньо екрануємо всі поля що будуть у innerHTML
  const _eFn    = _htmlEsc(info.firstName || '');
  const _eLn    = _htmlEsc(info.lastName  || '');
  const _ePh    = _htmlEsc(info.phone     || '');
  const _eEm    = _htmlEsc(info.email     || '');
  const _eName  = _htmlEsc(displayName);
  const _eFill  = info.fill ? ` · ${_htmlEsc(info.fill)}`  : '';
  const _eCity  = info.city ? ` · ${_htmlEsc(info.city)}`  : '';
  const _ePic   = _safePic(info.picture);

  modal.innerHTML = `
    <h2>🚀 Імпорт в Teamtailor</h2>
    <div class="tt-candidate-preview">
      ${_ePic
        ? `<img src="${_ePic}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`
        : `<div class="tt-avatar-placeholder">${_htmlEsc((info.firstName?.[0] || info.lastName?.[0] || '?').toUpperCase())}</div>`}
      <div class="tt-preview-info">
        <div class="tt-preview-name">${_eName}</div>
        <div class="tt-preview-meta">robota.ua${_eFill}${_eCity}</div>
      </div>
    </div>
    <div class="tt-field"><label>Ім'я</label><input id="tt-fn" value="${_eFn}"></div>
    <div class="tt-field"><label>Прізвище</label><input id="tt-ln" value="${_eLn}"></div>
    <div class="tt-field"><label>Телефон</label><input id="tt-phone" value="${_ePh}" placeholder="+380..."></div>
    <div class="tt-field"><label>Email</label><input id="tt-email" value="${_eEm}" placeholder="email@..."></div>
    <div class="tt-field"><label>Вакансія</label><select id="tt-job"><option value="">— без вакансії —</option></select></div>
    <div class="tt-field"><label>Локація</label><select id="tt-loc"><option value="">— без локації —</option></select></div>
    <div class="tt-field"><label>Відділ</label><select id="tt-dept"><option value="">— без відділу —</option></select></div>
    <div class="tt-field"><label>Роль</label><select id="tt-role"><option value="">— без ролі —</option></select></div>
    <div class="tt-field"><label>Теги</label><div class="tt-tags-wrap" id="tt-tags"></div></div>
    <div class="tt-field"><label>Коментар</label><textarea id="tt-comment" placeholder="Коментар..."></textarea></div>
    ${info.resumeText ? `
    <div class="tt-field" id="tt-resume-field">
      <label>📝 Lettera di presentazione <span style="color:#b2bec3;font-weight:400;font-size:11px;">${(info.resumeUrl && /^transient:/i.test(info.resumeUrl)) ? '(файл резюме вже завантажено; цей текст додається як опис)' : '(буде додано як cover-letter кандидатури)'}</span></label>
      <textarea id="tt-resume-text" rows="6" style="font-size:11px;line-height:1.5;resize:vertical;">${(info.resumeText || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
    </div>` : ''}
    <div class="tt-modal-actions">
      <button class="tt-btn-cancel" id="tt-cancel">Скасувати</button>
      <button class="tt-btn" id="tt-confirm">✓ Імпортувати</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // ── Кнопка завантаження резюме ──
  // Умова: є числовий applyId, є тип резюме, тип не NoCvApply,
  // Interaction → потрібен ще resumeId (бо getfile не підтримує Interaction без resumeId)
  // Ховаємо кнопку лише якщо файл вже завантажено вручну (transient:/ URI).
  // https:// URL від robota.ua НЕ вважається "вже завантаженим" — TT не може їх скачати,
  // тому кнопка залишається доступною (на випадок якщо авто-завантаження не спрацює).
  const _hasUploadedFile = !!(info.resumeUrl && /^transient:/i.test(info.resumeUrl));
  const _canDownload = info.numericApplyId
    && info.resumeType
    && info.resumeType !== 'NoCvApply'
    && !(info.resumeType === 'Interaction' && !info.resumeId)
    && !_hasUploadedFile;
  if (_canDownload) {
    const dlWrap = document.createElement('div');
    dlWrap.className = 'tt-field';
    dlWrap.style.marginTop = '0';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'tt-btn';
    dlBtn.style.cssText = 'width:100%;background:#0984e3;margin-bottom:4px;';
    dlBtn.textContent = '⬇️ Завантажити резюме в TT';
    dlBtn.addEventListener('click', async () => {
      dlBtn.textContent = '⏳ Завантажую...';
      dlBtn.disabled = true;
      try {
        console.log('[TT] ⬇️ ROBOTA_UPLOAD_RESUME →',
          'applyId:', info.numericApplyId,
          'resumeId:', info.resumeId || '(none)',
          'resumeType:', info.resumeType
        );
        const resp = await bgMsg({
          type:             'ROBOTA_UPLOAD_RESUME',
          applyId:          info.numericApplyId,
          resumeId:         info.resumeId          || '',  // для Selected/Interaction кандидатів
          strApplyId:       info.strApplyId        || '',  // повний ID з суфіксом (-attach тощо)
          resumeType:       info.resumeType,
          originalFileName: info.originalFileName  || '',  // оригінальна назва файлу (AttachedFile)
          resumeUrl:        info.resumeUrl         || ''   // CVDB fallback: якщо getfile → 500
        });
        console.log('[TT] ⬇️ ROBOTA_UPLOAD_RESUME ← ok:', resp?.ok, 'url:', resp?.url || '(none)');
        if (resp?.ok && resp.url) {
          info.resumeUrl = resp.url;
          dlBtn.textContent = '✅ Резюме завантажено';
          // Ховаємо textarea — файл завантажено, cover-letter не потрібен
          const resumeField = modal.querySelector('#tt-resume-field');
          if (resumeField) resumeField.style.display = 'none';
        } else {
          dlBtn.textContent = '❌ Помилка завантаження';
          dlBtn.disabled = false;
        }
      } catch (e) {
        dlBtn.textContent = '❌ Помилка';
        dlBtn.disabled = false;
      }
    });

    dlWrap.appendChild(dlBtn);
    const actions = modal.querySelector('.tt-modal-actions');
    if (actions) modal.insertBefore(dlWrap, actions);
  }

  bgMsg({ type: 'GET_TT_LISTS' }).then(resp => {
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
    // Vacancy-specific job mapping: якщо ця robota-вакансія вже прив'язана до TT-вакансії —
    // підставляємо автоматично, інакше беремо default
    const vacancyJobId = (prefs.robota_vacancy_job_map || {})[info.vacancyId] || prefs.default_job_id;
    fill('#tt-job',  resp.jobs,  'internal-name', vacancyJobId);
    fill('#tt-loc',  resp.locs,  'name',          prefs.default_loc_id);
    fill('#tt-dept', resp.depts, 'name',          prefs.default_dept_id);
    fill('#tt-role', resp.roles, 'name',          prefs.default_role_id);
  }).catch(() => {});

  const tagsWrap = modal.querySelector('#tt-tags');
  const selectedTags = new Set(initTags);
  let allAvailableTags = [...FIXED_TAGS.filter(t => t !== 'robota.ua' && t !== 'work.ua')];

  // ── Рендер: показуємо лише обрані чіпи + кнопка "Змінити" з дропдауном ──
  const _renderTagsUI = () => {
    tagsWrap.innerHTML = '';

    // Чіпи обраних тегів
    const chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;';
    selectedTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tt-tag selected';
      chip.textContent = tag;
      chip.dataset.tag = tag;
      // Клік по чіпу — знімає тег
      chip.addEventListener('click', () => {
        selectedTags.delete(tag);
        _renderTagsUI();
      });
      chipsWrap.appendChild(chip);
    });

    // Кнопка "Змінити ▾"
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'position:relative;display:inline-block;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Змінити ▾';
    btn.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:10px;border:1.5px solid #dfe6e9;background:#f0f2f5;color:#2d3436;cursor:pointer;white-space:nowrap;';

    const dropdown = document.createElement('div');
    dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:9999;background:#fff;border:1.5px solid #e84b3c;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.13);min-width:200px;max-height:220px;overflow-y:auto;padding:4px;';

    const _fillDropdown = () => {
      dropdown.innerHTML = '';
      const skipTags = new Set(['robota.ua', 'work.ua']);
      allAvailableTags.filter(t => !skipTags.has(t)).forEach(tag => {
        const item = document.createElement('div');
        item.textContent = tag;
        const isSelected = selectedTags.has(tag);
        item.style.cssText = `padding:6px 10px;font-size:12px;cursor:pointer;border-radius:5px;background:${isSelected ? '#e84b3c' : ''};color:${isSelected ? '#fff' : '#2d3436'};`;
        item.addEventListener('mouseenter', () => { if (!isSelected) item.style.background = '#f0f2f5'; });
        item.addEventListener('mouseleave', () => { if (!isSelected) item.style.background = ''; });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          isSelected ? selectedTags.delete(tag) : selectedTags.add(tag);
          dropdown.style.display = 'none';
          _renderTagsUI();
        });
        dropdown.appendChild(item);
      });
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      dropdown.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) _fillDropdown();
    });
    document.addEventListener('click', () => { dropdown.style.display = 'none'; }, { once: false });

    btnWrap.appendChild(btn);
    btnWrap.appendChild(dropdown);
    chipsWrap.appendChild(btnWrap);
    tagsWrap.appendChild(chipsWrap);
  };

  _renderTagsUI();

  // Асинхронно довантажуємо теги з TT і оновлюємо дропдаун
  bgMsg({ type: 'GET_TT_TAGS' }).then(resp => {
    if (!resp?.tags?.length) return;
    const fixedSet = new Set(allAvailableTags.map(t => t.toLowerCase()));
    const skipTags = new Set(['robota.ua', 'work.ua']);
    for (const tag of resp.tags) {
      if (!skipTags.has(tag.toLowerCase()) && !fixedSet.has(tag.toLowerCase())) {
        allAvailableTags.push(tag);
      }
    }
  }).catch(() => {});

  modal.querySelector('#tt-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  modal.querySelector('#tt-confirm').addEventListener('click', async () => {
    const confirmBtn = modal.querySelector('#tt-confirm');

    const c = {
      firstName:  modal.querySelector('#tt-fn').value.trim()    || info.firstName,
      lastName:   modal.querySelector('#tt-ln').value.trim()    || info.lastName,
      phone:      modal.querySelector('#tt-phone').value.trim(),
      email:      modal.querySelector('#tt-email').value.trim(),
      picture:    info.picture,
      city:       info.city,
      jobId:      modal.querySelector('#tt-job').value,
      locationId: modal.querySelector('#tt-loc').value,
      deptId:     modal.querySelector('#tt-dept').value,
      roleId:     modal.querySelector('#tt-role').value,
      comment:    modal.querySelector('#tt-comment').value.trim(),
      tags:       [...selectedTags],
      source:     'robota.ua',
      // Канонічний URL профілю: пряме посилання /candidates/{id} якщо є числовий ID,
      // інакше поточний URL (може містити ?id= UUID — також корисний для переходу).
      robotaUrl:  info.numericApplyId
        ? `https://robota.ua/candidates/${info.numericApplyId}`
        : (info.href?.match(/\/candidates\/\d{6,}/) ? info.href : (info.href || location.href)),
      sourceUrl:  info.href || location.href,
      resumeText:     modal.querySelector('#tt-resume-text')?.value?.trim() || info.resumeText || '',
      resumeUrl:      info.resumeUrl      || '',
      numericApplyId: info.numericApplyId || '',
      resumeType:     info.resumeType     || '',
      strApplyId:     info.strApplyId     || '',
      resumeId:       info.resumeId       || ''
    };

    confirmBtn.textContent = '⏳ Імпортую...';
    confirmBtn.className   = 'tt-btn loading';
    confirmBtn.disabled    = true;
    _lockCandidateNav(true); // блокуємо стрілки між кандидатами під час API-виклику

    const resp = await bgMsg({ type: 'IMPORT_CANDIDATE', candidate: c });
    _lockCandidateNav(false);
    if (resp?.ok) {
      confirmBtn.textContent = '✅ Додано!';
      confirmBtn.className   = 'tt-btn success';

      // ── Зберігаємо red статус одразу після імпорту ─────────
      // Наступне відкриття сторінки показуватиме бейдж без TT API запиту.
      // Це ключова оптимізація для великих баз (50к+): замість повторного checkDuplicate
      // — миттєве відображення з persistent кешу.
      const _importedCardId = info.applyId || info.fullName;
      if (_importedCardId && resp.result?.url) {
        const _ttImported = {
          id:   String(resp.result?.candidateId || resp.result?.url?.split('/').pop() || ''),
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          url:  resp.result.url
        };
        persistDupe(_importedCardId, 'red', _ttImported);
        checkCache.set(_importedCardId, { status: 'red', ttData: _ttImported, info: { ...info, ...c } });
      }

      // Запам'ятовуємо прив'язку robota-вакансія → TT-вакансія для наступних імпортів
      if (info.vacancyId && c.jobId) {
        const map = prefs.robota_vacancy_job_map || {};
        map[info.vacancyId] = c.jobId;
        prefs.robota_vacancy_job_map = map;
        chrome.storage.local.set({ robota_vacancy_job_map: map });
      }

      if (typeof onImported === 'function') {
        onImported(resp.result || null);
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

// ── Читаємо JWT з localStorage / sessionStorage (запасний варіант) ──
// ОСНОВНЕ джерело токена: chrome.webRequest.onSendHeaders у background.js
// (перехоплює Bearer токен з усіх запитів robota.ua → employer-api автоматично)
// Цей fallback потрібен якщо robota.ua раптом почне зберігати JWT у storage
async function getLocalStorageToken() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const val = storage.getItem(storage.key(i));
        if (val && val.length > 50 && val.startsWith('eyJ')) return val;
      }
    } catch (_) {}
  }
  return null;
}

// ── Селектор карток (підтримує всі сторінки robota.ua) ──────
// robota.ua використовує різні Angular-компоненти на різних сторінках
const CARD_SELECTORS = [
  'alliance-employer-candidates-list-card-desktop',          // /candidates
  'alliance-employer-applies-list-card-desktop',             // /all/applies (варіант 1)
  'alliance-employer-vacancies-applies-list-card',           // /all/applies (варіант 2)
  'alliance-employer-recommended-candidates-list-card',      // /recommended
  'alliance-employer-recommended-list-card-desktop',         // /recommended (варіант 2)
  'alliance-employer-interactions-list-card-desktop',        // /interactions
  'alliance-employer-vacancies-candidates-list-card',        // /candidates (варіант 2)
  // /candidates/all/* — пошук резюме (база кандидатів) — різні варіанти назв
  'alliance-employer-resume-card',
  'alliance-employer-resume-list-card',
  'alliance-employer-resume-list-card-desktop',
  'alliance-employer-resume-search-card',
  'alliance-employer-resume-search-list-card',
  'alliance-employer-candidates-resume-card',
  'alliance-employer-candidates-resume-list-card',
  'alliance-employer-cvdb-resume-card',
  'alliance-employer-cvdb-card',
  'alliance-employer-cvdb-list-card',
  'alliance-employer-candidates-base-card',
  'alliance-employer-candidates-base-list-card',
  'alliance-employer-candidates-serp-card',
  'alliance-employer-candidates-all-card',
  'alliance-employer-candidates-all-list-card',
  'alliance-employer-candidates-search-card',
  'alliance-employer-resume-serp-card',
  'alliance-employer-resume-card-desktop',
  'section.cv-card',                                          // /my/cvdb — Cleverstaff-confirmed
  // /all/applies — додаткові варіанти назв компонентів (robota.ua може змінювати)
  'alliance-employer-applies-list-item',
  'alliance-employer-applies-card',
  'alliance-employer-applies-list-card',
  'alliance-employer-vacancies-applies-card',
  'alliance-employer-vacancies-applies-item',
  'alliance-employer-vacancies-applies-list-item',
  'alliance-employer-applies-card-desktop',
  'alliance-employer-vacancies-all-applies-card',
].join(', ');

// ── Scan відгуків через посилання (fallback для /all/applies) ──────────────────
// Якщо Angular-компонент картки відгуку має нестандартне ім'я (не в CARD_SELECTORS) —
// знаходимо картку за посиланням /applies/{uuid} і вставляємо бейдж у батьківський контейнер.
function scanAppliesCards() {
  const seen = new Set();
  document.querySelectorAll('a[href*="/applies/"]').forEach(link => {
    const id = link.href.match(/\/applies?\/([0-9a-f\-]{8,})/i)?.[1] || '';
    if (!id || seen.has(id)) return;
    seen.add(id);

    let card = null;
    // Найближчий Angular-компонент з '-' у назві тегу (картка — окремий компонент)
    let el = link.parentElement;
    for (let i = 0; i < 14 && el && el !== document.body; i++) {
      if (el.tagName && el.tagName.includes('-')) {
        const r = el.getBoundingClientRect();
        if (r.height > 40 && r.height < 500 && r.width > 200) { card = el; break; }
      }
      el = el.parentElement;
    }
    if (!card) card = link.closest('article, li, [class*="card"], [class*="item"]');
    if (!card || card === document.body || card.dataset.ttProcessed) return;
    processCard(card);
  });
}

// ── Scan кандидатів через посилання (fallback для /candidates/all/* та /candidates/*) ──
// Якщо Angular-компонент має нестандартне ім'я (не в CARD_SELECTORS) — знаходимо
// картку за посиланням /candidates/{numericId} і вставляємо бейдж у батьківський контейнер.
function scanCandidateSearchCards() {
  const seen = new Set();
  document.querySelectorAll('a[href*="/candidates/"]').forEach(link => {
    // Тільки посилання на профіль (числовий ID ≥ 6 цифр), не на внутрішні сторінки
    const id = link.href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i)?.[1] || '';
    if (!id || seen.has(id)) return;
    seen.add(id);

    // Пошук картки: кілька стратегій від надійної до загальної
    let card = null;

    // 1. closest article або відомі CSS-класи карток
    card = link.closest(
      'article, [class*="resume-card"], [class*="resume-item"], [class*="candidate-card"]'
    );

    // 2. Найближчий Angular-компонент (тег з '-') — надійніший за BoundingClientRect:
    //    robota.ua будує UI з Angular-компонентів, і картка завжди є окремим компонентом.
    //    Шукаємо НАЙБЛИЖЧИЙ предок з '-' у назві тега (не враховуючи занадто широкі контейнери).
    if (!card) {
      let el = link.parentElement;
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        if (el.tagName && el.tagName.includes('-')) {
          // Перевіряємо що це окрема картка, а не список-контейнер
          // (картка ≤ 300px висоти; список-контейнер набагато вищий)
          const r = el.getBoundingClientRect();
          if (r.height < 400) { card = el; break; }
        }
        el = el.parentElement;
      }
    }

    // 3. BoundingClientRect fallback (звичайні DOM-вузли без Angular)
    if (!card) {
      let el = link.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!el || el === document.body) break;
        const r = el.getBoundingClientRect();
        // Картка: width > 300, але НЕ занадто висока (< 400px), щоб не захопити список
        if (r.width > 300 && r.height > 60 && r.height < 400) { card = el; break; }
        el = el.parentElement;
      }
    }

    if (!card || card === document.body || card.dataset.ttProcessed) return;
    if (card.querySelector('.tt-badge-wrap')) return; // вже є бейдж

    // Перевірка: це справді одна картка, а не список/контейнер
    const _cr = card.getBoundingClientRect();
    if (_cr.height > 350) return; // занадто висока — це контейнер зі списком

    const _cLinks = card.querySelectorAll('a[href*="/candidates/"]');
    const _cIds = new Set(
      [..._cLinks].map(l => (l.href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i) || [])[1]).filter(Boolean)
    );
    if (_cIds.size > 2) return; // більше 2 різних кандидатів — це контейнер, не картка

    processCard(card);
  });

  // ── Крок 4: CVDB-сторінка (alliance-employer-cvdb-card-content-desktop) ──────
  // На /candidates/all/ukraine посилання /candidates/{id} є БАТЬКІВСЬКИМ елементом картки,
  // а не дочірнім — тому кроки 1-3 взагалі не знаходять ці картки.
  // Скануємо компонент напряму, знаходимо ID у батьківському <a>, записуємо в data-resume-id.
  document.querySelectorAll('alliance-employer-cvdb-card-content-desktop').forEach(cvdbCard => {
    if (cvdbCard.dataset.ttProcessed || cvdbCard.querySelector('.tt-badge-wrap')) return;

    // Йдемо вгору DOM щоб знайти <a href="/candidates/{id}">
    let el = cvdbCard.parentElement;
    let foundId = '';
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      const href = el.getAttribute('href') || '';
      const m = href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i);
      if (m) { foundId = m[1]; break; }
      el = el.parentElement;
    }

    // Не перевіряємо seen: перший цикл міг додати ID до seen коли знайшов батьківський <a>,
    // але не знайшов картку (картка є дочірнім елементом, не батьківським).
    // Деduplication виконується через dataset.ttProcessed (вже перевірено вище).
    if (foundId) {
      cvdbCard.dataset.resumeId = foundId;
      if (!resumeIdMap.has(foundId)) resumeIdMap.set(foundId, foundId);
      // CVDB-кандидат: резюме зі бази → тип 'Selected' для GET /apply/getfile/{id}?resumeType=Selected
      // Без цього getFullCandidateData не знає тип → авто-завантаження файлу не спрацьовує
      if (!applyCache.has(foundId)) {
        applyCache.set(foundId, {
          _resumeType:     'Selected',
          _numericApplyId: foundId,
          _resumeId:       foundId,
          _strApplyId:     foundId
        });
      }
    }

    processCard(cvdbCard);
  });
}

// ── Observer з debounce ────────────────────────────────────
function observeAll() {
  let debTimer    = null;
  let lastPanelId = ''; // слідкуємо за зміною кандидата в панелі
  let lastUrl     = location.href; // BUG-14: відстежуємо SPA-навігацію

  // Чи це сторінка пошуку резюме (база кандидатів)?
  // Перевіряємо динамічно (може змінитись після SPA-навігації — оновлюємо в scanCards).
  let isCvSearch = (/\/candidates(?:\/all)?\//i.test(location.pathname) &&
                    !/\/my\/vacancies\//i.test(location.pathname)) ||
                   /\/my\/cvdb\b/i.test(location.pathname);

  const scanCards = () => {
    // BUG-14: Angular SPA змінює URL без перезавантаження сторінки (history.pushState).
    // init() запускається лише один раз → preloadApplyList не викликається при переході
    // між вакансіями. Перевіряємо URL і запускаємо preload якщо він змінився.
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      // Перераховуємо тип сторінки після навігації
      isCvSearch = (/\/candidates(?:\/all)?\//i.test(location.pathname) &&
                    !/\/my\/vacancies\//i.test(location.pathname)) ||
                   /\/my\/cvdb\b/i.test(location.pathname);
      // preloadApplyList сам перевіряє _preloadDoneForVacancy — не запустить двічі для тієї самої вакансії
      preloadApplyList();
    }
    // Guard: skip if card already has a badge (Angular re-render protection)
    document.querySelectorAll(CARD_SELECTORS).forEach(card => {
      if (!card.dataset.ttProcessed && !card.querySelector('.tt-badge-wrap')) {
        processCard(card);
      }
    });

    // Fallback-сканер для сторінки пошуку резюме (Angular компоненти з нестандартними іменами)
    if (isCvSearch) scanCandidateSearchCards();

    // Fallback-сканер для /all/applies — якщо CARD_SELECTORS не впіймав компонент
    const _isAppliesPage = /\/my\/vacancies\/all\/applies/i.test(location.pathname)
                        || /\/my\/vacancies\/\d+\/applies/i.test(location.pathname);
    if (_isAppliesPage) scanAppliesCards();

    // Панель А: split-view (список + права панель деталей)
    let panel = document.querySelector('alliance-employer-candidates-candidate-panel-desktop');

    // Панель Б: standalone /candidates/{id} — пряма сторінка профілю кандидата
    // УВАГА: пошук "Запропонувати вакансію" — ТІЛЬКИ на /candidates/{numericId}.
    // На сторінках-списках (/candidates/all/*) він знаходить aside-фільтри і помилково
    // вставляє кнопку +TT у панель фільтрів.
    const _isStandalonePage = /\/candidates\/\d{6,}(?:[/?#]|$)/i.test(location.pathname);
    if (!panel && _isStandalonePage) {
      const _vpBtn = [...document.querySelectorAll('button, a')].find(
        el => !el.closest('nav, header') && (el.textContent || '').trim().includes('Запропонувати вакансію')
      );
      panel = _vpBtn?.closest('aside, section, [class*="sidebar"], [class*="actions"], [class*="contact"]')
           || _vpBtn?.parentElement?.parentElement
           || null;
    }

    // Панель В: модальне вікно vacancy pipeline (Cleverstaff pattern)
    // URL: /my/vacancies/{id}/candidates?id=...-attach/select/interaction тощо
    // Angular рендерить профіль у <santa-vertical-modal> з animate-класом .ng-trigger-openState
    if (!panel) {
      panel = document.querySelector('santa-vertical-modal .ng-trigger-openState')
           || document.querySelector('santa-vertical-modal');
    }

    // Панель Г: standalone CVDB resume page (/my/cvdb/{id})
    // Окрема сторінка резюме з бази — Angular рендерить у головному блоку <main> або <article>
    const _isCvdbPage = /\/my\/cvdb\/\d{5,}(?:[/?#]|$)/i.test(location.pathname);
    if (!panel && _isCvdbPage) {
      panel = document.querySelector('main, article, [class*="resume"], [class*="cv-card"]')
           || document.body;
    }

    if (!panel) { lastPanelId = ''; return; }

    // Перевіряємо чи змінився кандидат (URL ?id=, /candidates/{id}, або /my/cvdb/{id})
    const curId = (location.href.match(/[?&]id=([^&\s#]+)/i)
               || location.href.match(/\/candidates\/(\d{6,})(?:[/?#]|$)/i)
               || location.href.match(/\/my\/cvdb\/(\d{5,})(?:[/?#]|$)/i)
               || [])[1] || '';
    if (curId && curId !== lastPanelId) {
      lastPanelId = curId;
      delete panel.dataset.ttBtn;
      panel.querySelectorAll('.tt-btn').forEach(b => b.remove());
    }

    if (!panel.dataset.ttBtn) addDetailButton(panel);
  };

  const observer = new MutationObserver(() => {
    clearTimeout(debTimer);
    debTimer = setTimeout(scanCards, 120);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Backend batch pre-check ────────────────────────────────
// Збирає всі видимі applyId → один запит до backend → кешує результати.
// processCard бачить їх у checkCache → малює бейдж без TT API.
async function preloadFromBackend() {
  try {
    const cards  = [...document.querySelectorAll(CARD_SELECTORS)];
    const ids    = [];
    const idMap  = new Map(); // backendKey → cardId
    for (const card of cards) {
      const info  = extractFromCard(card);
      const cid   = info.applyId ? info.applyId.replace(/-[a-z][a-z]*$/i, '') : '';
      if (!cid) continue;
      const key = `robota:${cid}`;
      ids.push(key);
      idMap.set(key, info.applyId || cid);
    }
    if (!ids.length) return;

    const resp = await bgMsg({ type: 'BACKEND_BATCH_CHECK', ids });
    if (!resp?.ok || !resp?.result) return;

    for (const [backendKey, ttData] of Object.entries(resp.result)) {
      const cardId = idMap.get(backendKey);
      if (!cardId || !ttData?.ttId) continue;
      const ttEntry = { id: ttData.ttId, name: ttData.ttName || '', url: ttData.ttUrl || '' };
      // Записуємо в checkCache і persistent — processCard пропустить TT API виклик
      checkCache.set(cardId, { status: 'red', ttData: ttEntry, info: { applyId: cardId } });
      persistDupe(cardId, 'red', ttEntry);
    }
    const found = Object.keys(resp.result).length;
    if (found) console.log(`[TT] backend batch: ${found}/${ids.length} знайдено в кеші`);
  } catch (_) {}
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  await loadPrefs();

  // ── Backend batch-check ПЕРШИЙ (найшвидший шлях) ──────────
  // Якщо backend налаштовано: 1 запит → всі відомі дублі заповнюють checkCache
  // → processCard малює бейджі без TT API. Решта проходять звичайний flow.
  // Backend batch-check — чекаємо до 500ms (backend зазвичай ~30ms).
  // Без await processCard стартує раніше ніж checkCache заповнений → бейджі дублів
  // не відображаються одразу і гублять перевагу кешу.
  await Promise.race([preloadFromBackend(), new Promise(r => setTimeout(r, 500))]);

  // Основне джерело JWT-токена: chrome.webRequest.onSendHeaders у background.js
  // автоматично перехоплює Bearer-токен з запитів robota.ua → employer-api.
  // robota.ua Angular SPA НЕ зберігає JWT в localStorage (лише 4 аналітичних ключі).
  // Нижче — тихий запасний шлях на випадок якщо це колись зміниться.
  try {
    const localToken = await getLocalStorageToken();
    if (localToken) await bgMsg({ type: 'CACHE_ROBOTA_TOKEN', token: localToken });
  } catch (_) {}

  // Завантажуємо список відгуків у фоні (будуємо applyId→resumeId карту).
  // Перший виклик може бути до захоплення токена — другий (через 2.5 с) гарантує
  // що onSendHeaders вже встиг перехопити токен із запитів Angular-додатку.
  preloadApplyList();
  setTimeout(() => preloadApplyList(), 2500);

  document.querySelectorAll(CARD_SELECTORS).forEach(card => {
    if (!card.dataset.ttProcessed && !card.querySelector('.tt-badge-wrap')) processCard(card);
  });

  // Fallback для сторінки пошуку резюме (база кандидатів)
  const isCvSearch = (/\/candidates(?:\/all)?\//i.test(location.pathname) &&
                      !/\/my\/vacancies\//i.test(location.pathname)) ||
                     /\/my\/cvdb\b/i.test(location.pathname);
  if (isCvSearch) scanCandidateSearchCards();

  // Панель: split-view або standalone /candidates/{id} або /my/cvdb/{id}
  // Пошук "Запропонувати вакансію" — ТІЛЬКИ для /candidates/{numericId},
  // щоб не вставити кнопку у aside-фільтри на сторінках-списках.
  let _initPanel = document.querySelector('alliance-employer-candidates-candidate-panel-desktop');
  const _isStandaloneInit = /\/candidates\/\d{6,}(?:[/?#]|$)/i.test(location.pathname);
  if (!_initPanel && _isStandaloneInit) {
    const _vpBtn = [...document.querySelectorAll('button, a')].find(
      el => !el.closest('nav, header') && (el.textContent || '').trim().includes('Запропонувати вакансію')
    );
    _initPanel = _vpBtn?.closest('aside, section, [class*="sidebar"], [class*="actions"], [class*="contact"]')
              || _vpBtn?.parentElement?.parentElement
              || null;
  }
  // Standalone CVDB resume page: /my/cvdb/{id}
  const _isCvdbInit = /\/my\/cvdb\/\d{5,}(?:[/?#]|$)/i.test(location.pathname);
  if (!_initPanel && _isCvdbInit) {
    _initPanel = document.querySelector('main, article, [class*="resume"], [class*="cv-card"]')
              || document.body;
  }
  if (_initPanel) addDetailButton(_initPanel);

  observeAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
