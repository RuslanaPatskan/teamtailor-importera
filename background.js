// ============================================================
// Teamtailor Importera — background.js (Service Worker)
// v3.8 — PANEL_CHECK_DUPLICATE (no semaphore); panel re-check blocks +TT button
//
// API references:
//   Teamtailor:  https://docs.teamtailor.com/
//   robota.ua:   https://employer-api.robota.ua/swagger/index.html
//                  POST /apply/list          — список відгуків (+ candidateTypes фільтр)
//                  POST /apply               — деталі одного відгуку (GetApply, body: {id})
//                  POST /apply/view/{id}     — переглянути (повертає контакти)
//                  GET  /apply/getfile/{id}  — завантажити файл резюме
//                  GET  /resume/{id}         — повне резюме за ID (для /cvdb/resumes)
//                  POST /resume/{id}/contacts/visibility — відкрити контакти
//                  PUT  /resume/ats/{id}     — позначити резюме як додане до ATS
//                  POST /cvdb/resumes        — пошук бази резюме (catched via spy)
// ============================================================

const TT_BASE        = 'https://api.teamtailor.com/v1';
const TT_API_VERSION = '20240904';
const TT_COMPANY_SLUG = 'sANaNEhQiec';
const ROBOTA_API     = 'https://employer-api.robota.ua';

// (видалено: _robotaApply404Cache — GET /apply/{id} не існує в API,
//  виправлено на POST /apply — 404-кеш більше не потрібен)

// ── Semaphore: обмеження паралельних запитів до TT API ────────
// Load test (30 юзерів × stagger=0): 94% запитів = 429.
// TT rate limit: ~50 req/10s на акаунт (спільний для всіх юзерів розширення).
// При 10 активних рекрутерів × 2 слоти = 20 паралельних → безпечно.
// При 20+ рекрутерів → ризик 429 навіть з семафором.
// Семафор захищає від лавини при завантаженні ОДНІЄЇ сторінки (50 карток).
// Глобальний rate limit між юзерами — вирішується кешем (getTTLists, getTTCandidateTags).
const _TT_CONCURRENCY       = 4;  // для CHECK_DUPLICATE (phone/email + GraphQL)
const _TT_PANEL_CONCURRENCY = 8;  // для PANEL_CHECK_DUPLICATE (name only, легші запити)
let   _ttActiveCount  = 0;
const _ttQueue        = [];   // { resolve } — чекають на слот
let   _ttPanelActive  = 0;
const _ttPanelQueue   = [];

// ── Global TT rate throttle ────────────────────────────────
// Load test показав: 30 юзерів без затримок → 94% 429.
// Мінімальний інтервал між запитами: 120ms → max ~8 req/s → безпечно при 5-10 юзерах.
// fetchWithRetry вже обробляє 429 з retry, але краще не допускати їх взагалі.
let _lastTtRequestTime = 0;
const _TT_MIN_INTERVAL = 120; // ms між запитами

async function _ttThrottle() {
  const now  = Date.now();
  const wait = _TT_MIN_INTERVAL - (now - _lastTtRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastTtRequestTime = Date.now();
}

function _ttAcquire() {
  return new Promise(resolve => {
    if (_ttActiveCount < _TT_CONCURRENCY) {
      _ttActiveCount++;
      resolve();
    } else {
      _ttQueue.push({ resolve });
    }
  });
}

function _ttRelease() {
  if (_ttQueue.length > 0) {
    const next = _ttQueue.shift();
    next.resolve();
  } else {
    _ttActiveCount--;
  }
}

// Обгортка: виконує fn() тільки коли є вільний слот
async function _withTtSemaphore(fn) {
  await _ttAcquire();
  try { return await fn(); }
  finally { _ttRelease(); }
}

// Окремий семафор для PANEL_CHECK_DUPLICATE — вищий concurrency, легші запити
async function _withPanelSemaphore(fn) {
  await new Promise(resolve => {
    if (_ttPanelActive < _TT_PANEL_CONCURRENCY) { _ttPanelActive++; resolve(); }
    else _ttPanelQueue.push({ resolve });
  });
  try { return await fn(); }
  finally {
    if (_ttPanelQueue.length > 0) { _ttPanelQueue.shift().resolve(); }
    else _ttPanelActive--;
  }
}

// ── Backend batch-cache (Cleverstaff-style dedup index) ───
// POST /check  → повертає які ID вже є в TT (з нашої БД маппінгів)
// POST /save   → зберігає маппінг після імпорту
// POST /delete → видаляє маппінг якщо кандидата видалено з TT
//
// Формат ключів: "robota:{applyId}" або "work:{candidateId}"
// Якщо backend_url не налаштовано — функції повертають null/false тихо.

// Backend URL за замовчуванням — використовується якщо користувач не вказав свій.
// Щоб не показувати URL у налаштуваннях (підключається автоматично).
const DEFAULT_BACKEND_URL = 'https://tt-importera-cache.packan3.workers.dev';

async function _backendHeaders() {
  const p = await getPrefs();
  const h = { 'Content-Type': 'application/json' };
  if (p.backend_secret) h['x-secret'] = p.backend_secret;
  // Якщо backend_url порожній — беремо дефолтний (автопідключення без налаштування)
  const url = (p.backend_url || DEFAULT_BACKEND_URL).replace(/\/$/, '');
  return { url, headers: h };
}

async function backendBatchCheck(ids) {
  if (!ids?.length) return {};
  try {
    const { url, headers } = await _backendHeaders();
    if (!url) return {};
    const r = await fetch(`${url}/check`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ ids }),
      signal:  AbortSignal.timeout(4000)
    });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

async function backendSaveMapping(id, ttId, ttName, ttUrl) {
  try {
    const { url, headers } = await _backendHeaders();
    if (!url || !id || !ttId) return;
    await fetch(`${url}/save`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ id, ttId: String(ttId), ttName: ttName || '', ttUrl: ttUrl || '' }),
      signal:  AbortSignal.timeout(4000)
    });
  } catch (_) {}
}

async function backendDeleteMapping(id) {
  try {
    const { url, headers } = await _backendHeaders();
    if (!url || !id) return;
    await fetch(`${url}/delete`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ id }),
      signal:  AbortSignal.timeout(4000)
    });
  } catch (_) {}
}

// ── Keep-alive alarm (Cleverstaff pattern) ────────────────
// MV3 service worker завершується через ~30s бездіяльності, стираючи in-memory кеші
// (JWT-токен robota.ua, TT-токен тощо). Алярм кожні 24 с підтримує SW живим.
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {}); // no-op — сам виклик достатній

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Ім'я файлу з Content-Disposition (Cleverstaff pattern) ───────────────
// Підтримує: filename*=UTF-8''..., filename="...", file="..." (robota.ua docx),
// а також ISO-8859-1 Cyrillic garbling fix для кириличних імен файлів.
function _getFilenameFromResponse(response, fallback = 'resume.pdf') {
  const cd = response?.headers?.get('content-disposition') || '';
  if (!cd) return fallback;
  // RFC5987: filename*=UTF-8''percent-encoded
  const rfc5987 = cd.match(/filename\*=UTF-8''([^;\s\r\n]+)/i);
  if (rfc5987) {
    try { return decodeURIComponent(rfc5987[1]); } catch (_) {}
  }
  // Стандартний filename= або file= (robota.ua docx-варіант)
  const stdMatch = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\r\n]*)/i)
                || cd.match(/file[^;=\n]*=((['"]).*?\2|[^;\r\n]*)/i);
  if (stdMatch) {
    let fn = (stdMatch[1] || '').replace(/^["']|["']$/g, '').trim();
    if (fn) {
      // ISO-8859-1 → UTF-8: сервер повернув кирилицю як Latin-1 байти
      if (/[^\x20-\x7E]/.test(fn)) {
        try {
          fn = decodeURIComponent(
            Array.from(fn).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
          );
        } catch (_) {}
      }
      return fn.trim() || fallback;
    }
  }
  return fallback;
}

// ── dracula.robota.ua — GraphQL resume download (Cleverstaff pattern) ────────
// Cleverstaff використовує GraphQL endpoint dracula.robota.ua для отримання резюме
// як base64 PDF одразу у відповіді, без додаткових бінарних fetch.
// Авторизація: jwt-token cookie robota.ua як Bearer token.
//
// Два запити:
//   getResumeFile            → для CVDB/профіль-сторінок (seekerResume.pdf.dataUrl)
//   getCandidatesResumeFile  → для applies-сторінок (ProfResume | AttachResume)

const DRACULA_API = 'https://dracula.robota.ua/';

// Зчитує jwt-token cookie з robota.ua для авторизації в GraphQL.
async function _getRobotaJwt() {
  try {
    const c = await chrome.cookies.get({ url: 'https://robota.ua', name: 'jwt-token' });
    return c?.value || null;
  } catch (_) { return null; }
}

// Для CVDB / профіль-сторінок: seekerResume → pdf.dataUrl (base64 PDF inline)
// resumeId — числовий ID резюме (з URL /resumes/{id} або /my/cvdb/{id})
async function _draculaGetResumeFile(resumeId) {
  if (!resumeId) return null;
  const jwt = await _getRobotaJwt();
  if (!jwt) { console.log('[TT BG] dracula: jwt-token не знайдено, пропускаємо'); return null; }
  try {
    const r = await fetch(DRACULA_API + '?q=getResumeFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      credentials: 'include',
      body: JSON.stringify({
        operationName: 'getResumeFile',
        variables: { id: String(resumeId) },
        query: `query getResumeFile($id: ID!) {
          seekerResume(id: $id) {
            id
            personal { firstName surName }
            pdf { ... on Pdf { dataUrl } }
          }
        }`
      })
    });
    if (!r.ok) { console.warn(`[TT BG] dracula getResumeFile ← ${r.status}`); return null; }
    const data = await r.json();
    const node = data?.data?.seekerResume;
    if (!node) return null;

    // ПІБ з personal (surName = прізвище у robota.ua GraphQL)
    const firstName = node.personal?.firstName || '';
    const lastName  = node.personal?.surName   || '';

    const dataUrl = node.pdf?.dataUrl;
    if (!dataUrl) {
      // Навіть без PDF повертаємо ім'я — може допомогти коли файл недоступний
      if (firstName || lastName) {
        console.log('[TT BG] dracula getResumeFile: PDF відсутній, але ім\'я є:', firstName, lastName);
        return { base64: null, mimeType: null, fileName: null, firstName, lastName };
      }
      return null;
    }
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    if (!base64) return null;
    console.log('[TT BG] dracula getResumeFile ✓ resumeId:', resumeId, 'ім\'я:', firstName, lastName);
    return { base64, mimeType: 'application/pdf', fileName: `resume_${resumeId}.pdf`, firstName, lastName };
  } catch (e) { console.warn('[TT BG] dracula getResumeFile exception:', e); return null; }
}

// Для applies / vacancy candidates сторінок: applies → resume → ProfResume | AttachResume
// applyId — рядковий ID відгуку (strApplyId з суфіксом, напр. "abc123-select", або числовий)
async function _draculaGetApplyResumeFile(applyId) {
  if (!applyId) return null;
  const jwt = await _getRobotaJwt();
  if (!jwt) return null;
  try {
    const candId = String(applyId);
    const r = await fetch(DRACULA_API + '?q=getCandidatesResumeFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      credentials: 'include',
      body: JSON.stringify({
        operationName: 'getCandidatesResumeFile',
        variables: { filter: null, first: 1, where: { or: [{ and: [{ id: { in: [candId] } }] }] } },
        query: `query getCandidatesResumeFile($where: ApplyWhereInput, $filter: ApplyFilterInput, $first: Int) {
          applies(where: $where, filter: $filter, first: $first) {
            items {
              resume {
                ... on ApplyProfResume {
                  pdfFileName
                  pdf { ... on Pdf { dataUrl } }
                }
                ... on ApplyAttachResume {
                  downloadFileUrl
                  downloadFileName
                }
              }
            }
          }
        }`
      })
    });
    if (!r.ok) { console.warn(`[TT BG] dracula getCandidatesResumeFile ← ${r.status}`); return null; }
    const data = await r.json();
    const item = data?.data?.applies?.items?.[0];
    if (!item?.resume) return null;

    // ProfResume — PDF inline як base64 data URL
    if (item.resume.pdf?.dataUrl) {
      const dataUrl = item.resume.pdf.dataUrl;
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      if (!base64) return null;
      const fileName = item.resume.pdfFileName || `resume_${applyId}.pdf`;
      console.log('[TT BG] dracula getCandidatesResumeFile ProfResume ✓ applyId:', applyId);
      return { base64, mimeType: 'application/pdf', fileName };
    }

    // AttachResume — файл доступний за URL (docx/pdf/rtf), завантажуємо з credentials
    if (item.resume.downloadFileUrl) {
      const dlUrl  = item.resume.downloadFileUrl;
      const dlName = item.resume.downloadFileName || `resume_${applyId}`;
      console.log('[TT BG] dracula getCandidatesResumeFile AttachResume → fetch:', dlUrl);
      const fr = await fetch(dlUrl, { credentials: 'include' });
      if (!fr.ok) { console.warn(`[TT BG] dracula attach fetch ← ${fr.status}`); return null; }
      const cdName = _getFilenameFromResponse(fr, dlName);
      const ct     = (fr.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
      const ab     = await fr.arrayBuffer();
      if (!ab.byteLength) return null;
      const u8 = new Uint8Array(ab); let bin = '';
      u8.forEach(b => { bin += String.fromCharCode(b); });
      console.log('[TT BG] dracula attach ✓ name:', cdName, 'size:', ab.byteLength);
      return { base64: btoa(bin), mimeType: ct, fileName: cdName };
    }

    return null;
  } catch (e) { console.warn('[TT BG] dracula getCandidatesResumeFile exception:', e); return null; }
}

async function fetchWithRetry(url, options = {}, maxTries = 5) {
  // Throttle тільки TT API запити — не robota.ua, не backend
  if (url.startsWith('https://api.teamtailor.com')) {
    await _ttThrottle();
  }
  let lastErr;
  let lastStatus = 0;
  for (let i = 0; i < maxTries; i++) {
    try {
      const resp = await fetch(url, options);
      lastStatus = resp.status;

      if (resp.status === 429 && i < maxTries - 1) {
        // Поважаємо Retry-After (TT повертає кількість секунд).
        // Мінімум 10 с — менше не має сенсу при rate-limit вікні TT.
        const ra = parseInt(resp.headers.get('Retry-After') || '0', 10);
        const waitMs = Math.max(ra > 0 ? ra * 1000 : 0, 10000 + i * 5000);
        console.warn(`[TT BG] 429 Rate-Limited → чекаю ${Math.round(waitMs / 1000)}s (Retry-After: ${ra}s, спроба ${i + 1}/${maxTries})`);
        await sleep(waitMs);
        continue;
      }

      if (resp.status >= 500 && i < maxTries - 1) {
        await sleep(Math.pow(2, i) * 800);
        continue;
      }

      return resp;
    } catch (err) {
      lastErr = err;
      if (i < maxTries - 1) await sleep(Math.pow(2, i) * 800);
    }
  }
  throw lastErr ?? new Error(`fetchWithRetry: всі спроби вичерпано${lastStatus ? ` (останній статус: ${lastStatus})` : ''}`);
}

// ── Prefs кеш: chrome.storage.local.get(null) читає ВСЕ сховище ──────────
// При 10 користувачах × 4-5 читань на імпорт = сотні зайвих disk-reads.
// 5-секундний TTL: достатньо для однієї імпорт-сесії; при зміні налаштувань
// chrome.storage.onChanged інвалідує кеш миттєво.
let _prefsCache     = null;
let _prefsCacheTime = 0;
const _PREFS_TTL    = 5000; // 5 секунд

chrome.storage.onChanged.addListener(() => { _prefsCache = null; });

async function getPrefs() {
  if (_prefsCache && Date.now() - _prefsCacheTime < _PREFS_TTL) return _prefsCache;
  return new Promise(resolve => chrome.storage.local.get(null, r => {
    _prefsCache     = r || {};
    _prefsCacheTime = Date.now();
    resolve(_prefsCache);
  }));
}

// ── Teamtailor API ─────────────────────────────────────────
async function ttHeaders() {
  const prefs = await getPrefs();
  return {
    'Authorization': `Token token=${(prefs.tt_api_key || '').trim()}`,
    'Content-Type':  'application/vnd.api+json',
    'Accept':        'application/vnd.api+json',
    'X-Api-Version': TT_API_VERSION
  };
}

async function ttGetList(endpoint) {
  const headers = await ttHeaders();
  try {
    const resp = await fetchWithRetry(`${TT_BASE}${endpoint}`, { headers });
    if (!resp.ok) return [];
    return (await resp.json()).data || [];
  } catch (e) { return []; }
}


// ── Клієнтський точний збіг по імені ─────────────────────
// Приймає масив TT candidate objects + рядок імені.
// Перевіряє обидва порядки (ім'я↔прізвище) + нормалізацію NFC.
function ttMatchName(candidates, name) {
  if (!candidates?.length || !name?.trim()) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const pairSet = new Set([
    [parts[0], parts[1]].map(s => s.normalize('NFC').toLowerCase()).join('|'),
    [parts[1], parts[0]].map(s => s.normalize('NFC').toLowerCase()).join('|'),
  ]);
  if (parts.length >= 3) {
    pairSet.add([parts[0], parts[2]].map(s => s.normalize('NFC').toLowerCase()).join('|'));
    pairSet.add([parts[2], parts[0]].map(s => s.normalize('NFC').toLowerCase()).join('|'));
  }
  const pairs = [...pairSet].map(p => p.split('|'));
  const exact = candidates.find(c => {
    const fn = (c.attributes?.['first-name'] || '').normalize('NFC').toLowerCase().trim();
    const ln = (c.attributes?.['last-name']  || '').normalize('NFC').toLowerCase().trim();
    return pairs.some(([p0, p1]) => fn === p0 && ln === p1);
  });
  if (!exact) return null;
  return {
    id:        exact.id,
    name:      `${exact.attributes?.['first-name'] || ''} ${exact.attributes?.['last-name'] || ''}`.trim(),
    url:       `https://app.teamtailor.com/candidates/${exact.id}`,
    matchedBy: 'name'
  };
}

// ── Перевірка дубля ────────────────────────────────────────
async function checkDuplicate(phone, email, name) {

  const headers = await ttHeaders();

  // Допоміжна: будує result-об'єкт з TT candidate record
  const _mkResult = (c) => c?.id ? {
    id:    c.id,
    name:  `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim(),
    url:   `https://app.teamtailor.com/candidates/${c.id}`,
    email: c.attributes?.email || '',
    phone: c.attributes?.phone || ''
  } : null;

  // 1. По телефону — кілька форматів.
  // Після отримання відповіді ПЕРЕВІРЯЄМО що номер в TT справді збігається з шуканим
  // (TT filter[phone] може повертати несподівані результати для нестандартних форматів).
  if (phone && phone.trim()) {
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length >= 7) {
      const tail8 = digits.slice(-8); // останні 8 цифр — надійний порівняльник
      // Мінімальний набір варіантів (скорочено з 6 до 3) — зменшує навантаження на TT API.
      // TT зберігає номери переважно у форматі +380XXXXXXXXXX (як ми імпортуємо).
      // Пріоритет: +38XXXXXXXXXX → +XXXXXXXXXXX → оригінал.
      const variants = [...new Set([
        digits.startsWith('0')   ? `+38${digits}`      : null,  // +380987732300 (найчастіше в TT)
        digits.startsWith('380') ? `+${digits}`        : null,  // +380987732300 (вже є +)
        !digits.startsWith('0') && !digits.startsWith('380') ? `+${digits}` : null, // іноземний
        phone.trim(),                                            // оригінальний формат (fallback)
      ].filter(Boolean))];

      // Паралельний пошук — всі варіанти одночасно, без fetchWithRetry.
      // Таймаут 5с. Перший валідний збіг → abort решти (звільняємо TT rate limit).
      // _cancelCtrl: спільний AbortController що скасовує всі незавершені запити після першого збігу.
      const _cancelCtrl = new AbortController();
      const _phoneSearch = (v) => new Promise(resolve => {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 5000);
        // Скасовуємо цей запит якщо хтось інший знайшов збіг
        _cancelCtrl.signal.addEventListener('abort', () => { ctrl.abort(); clearTimeout(tid); });
        fetch(`${TT_BASE}/candidates?filter[phone]=${encodeURIComponent(v)}`,
              { headers, signal: ctrl.signal })
          .then(r => r.ok ? r.json() : { data: [] })
          .then(b => {
            clearTimeout(tid);
            const m = (b?.data || []).find(c => {
              if (!c.id) return false;
              const ttD = (c.attributes?.phone || '').replace(/\D/g, '');
              return ttD.length >= 7 && (ttD.endsWith(tail8) || tail8.endsWith(ttD.slice(-8)));
            });
            resolve(m ? { ..._mkResult(m), matchedBy: 'phone' } : null);
          })
          .catch(() => resolve(null));
      });

      // "First match wins" + abort решти після збігу
      const _phoneResult = await new Promise(resolve => {
        let remaining = variants.length;
        if (!remaining) { resolve(null); return; }
        variants.forEach(v => _phoneSearch(v).then(r => {
          if (r) { _cancelCtrl.abort(); resolve(r); }  // скасовуємо решту
          else if (--remaining === 0) resolve(null);
        }));
      });
      if (_phoneResult) return _phoneResult;
    }
  }

  // 2. По email — TT filter[email] є точним збігом, але все одно верифікуємо
  if (email && email.trim()) {
    const emailLc = email.trim().toLowerCase();
    try {
      const r = await fetchWithRetry(
        `${TT_BASE}/candidates?filter[email]=${encodeURIComponent(email.trim())}`,
        { headers }
      );
      if (r.ok) {
        const b = await r.json();
        const matched = b?.data?.find(c => c.id && (c.attributes?.email || '').toLowerCase() === emailLc);
        if (matched) return { ..._mkResult(matched), matchedBy: 'email' };
      }
    } catch (e) {}
  }

  // 3. По імені — спочатку точний збіг по полях, потім full-text як fallback
  if (name && name.trim()) {
    const parts = name.trim().normalize('NFC').split(/\s+/);

    // ── 3c. ОДНЕ СЛОВО (приватний режим: тільки прізвище або тільки ім'я) ─────
    // Якщо телефон і email порожні, а ім'я одне слово — пробуємо знайти в TT
    // одночасно як прізвище і як ім'я. Повертаємо тільки якщо в TT рівно 1 збіг
    // (щоб уникнути хибних спрацювань на поширені імена типу "Іван").
    if (parts.length === 1 && !phone && !email) {
      const word = parts[0];
      if (word.length >= 3) {
        const foundSingle = (b, field) => {
          if (!b?.data?.length) return null;
          // Точний збіг (case-insensitive, NFC-normalized)
          const matches = b.data.filter(c => {
            const val = (c.attributes?.[field] || '').normalize('NFC').toLowerCase().trim();
            return val === word.normalize('NFC').toLowerCase();
          });
          if (matches.length !== 1) return null; // 0 або >1 → ненадійно
          const c = matches[0];
          return {
            id:        c.id,
            name:      `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim(),
            url:       `https://app.teamtailor.com/candidates/${c.id}`,
            email:     c.attributes?.email || '',
            phone:     c.attributes?.phone || '',
            matchedBy: 'name'
          };
        };
        // Пробуємо як прізвище (найчастіший випадок: робота/work приватний режим)
        try {
          const r = await fetchWithRetry(
            `${TT_BASE}/candidates?filter[last-name]=${encodeURIComponent(word)}&page[size]=10`,
            { headers }
          );
          if (r.ok) { const b = await r.json(); const res = foundSingle(b, 'last-name');  if (res) return res; }
        } catch (e) {}
        // Пробуємо як ім'я (рідше, але можливо)
        try {
          const r = await fetchWithRetry(
            `${TT_BASE}/candidates?filter[first-name]=${encodeURIComponent(word)}&page[size]=10`,
            { headers }
          );
          if (r.ok) { const b = await r.json(); const res = foundSingle(b, 'first-name'); if (res) return res; }
        } catch (e) {}
      }
    }

    if (parts.length >= 2) {
      // Всі валідні пари (firstName, lastName) в обох порядках
      // ── 3a. По прізвищу: кожне слово як можливий last-name (2 запити) ──────
      for (const word of [parts[0], parts[1]]) {
        try {
          const r = await fetchWithRetry(
            `${TT_BASE}/candidates?filter[last-name]=${encodeURIComponent(word)}&page[size]=30`,
            { headers }
          );
          if (!r.ok) continue;
          const b = await r.json();
          const res = ttMatchName(b?.data || [], name);
          if (res) return res;
        } catch (e) {}
      }
    }
  }

  return null;
}

// ── Порівняти з TT ─────────────────────────────────────────
async function compareWithTT(ttId, candidate) {
  const headers = await ttHeaders();
  try {
    const r = await fetchWithRetry(`${TT_BASE}/candidates/${ttId}`, { headers });
    if (!r.ok) return null;
    const b = await r.json();
    const attrs = b?.data?.attributes || {};
    const diffs = [];
    if (candidate.phone && attrs.phone) {
      const cp = candidate.phone.replace(/\D/g, '');
      const tp = attrs.phone.replace(/\D/g, '');
      if (cp && tp && !tp.includes(cp.slice(-8))) diffs.push('phone');
    }
    if (candidate.email && attrs.email &&
        candidate.email.toLowerCase() !== attrs.email.toLowerCase()) diffs.push('email');
    return { hasDiffs: diffs.length > 0, diffs };
  } catch (e) { return null; }
}

// ── Кеш поточного user ID (для notes API — TT вимагає user relationship) ──
let _ttCurrentUserId     = null;
let _ttCurrentUserIdTime = 0;
const _TT_USER_ID_TTL    = 60 * 60 * 1000; // 1 година

async function getTTCurrentUserId(headers) {
  if (_ttCurrentUserId && Date.now() - _ttCurrentUserIdTime < _TT_USER_ID_TTL) {
    return _ttCurrentUserId;
  }
  try {
    // TT не має /me endpoint — беремо першого user з page[size]=1
    // API ключ завжди повертає свого власника першим
    const r = await fetchWithRetry(`${TT_BASE}/users?page[size]=1`, { headers });
    if (r.ok) {
      const body = await r.json();
      const uid = body?.data?.[0]?.id;
      if (uid) {
        _ttCurrentUserId     = String(uid);
        _ttCurrentUserIdTime = Date.now();
        console.log('[TT BG] current user ID:', _ttCurrentUserId);
        return _ttCurrentUserId;
      }
    }
  } catch(e) {}
  return null;
}

// ── Створити нотатку на картці кандидата ──────────────────
// Primary: офіційний POST /v1/notes (лише API key, без cookies, без slug).
// Fallback: внутрішній tt.teamtailor.com/api/comments (потребує сесію + slug).
async function createTTNote(candidateId, noteText, headers) {
  if (!candidateId || !noteText?.trim()) return false;
  const text = noteText.trim().substring(0, 10000);

  // 1. Офіційний API (рекомендовано)
  // TT docs: notes require BOTH candidate AND user relationships.
  const userId = await getTTCurrentUserId(headers);
  try {
    const relationships = {
      candidate: { data: { type: 'candidates', id: String(candidateId) } }
    };
    if (userId) {
      relationships.user = { data: { type: 'users', id: String(userId) } };
    }
    const r = await fetchWithRetry(`${TT_BASE}/notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'notes',
          attributes: { note: text },
          relationships
        }
      })
    });
    if (r.ok) { console.log('[TT BG] ✅ Note via POST /v1/notes'); return true; }
    const e = await r.json().catch(() => ({}));
    console.warn('[TT BG] POST /v1/notes failed:', r.status, JSON.stringify(e).substring(0, 200));
  } catch(e) { console.warn('[TT BG] POST /v1/notes exception:', e); }

  // 2. Fallback: внутрішній API (потребує session cookies + company slug)
  const slug = TT_COMPANY_SLUG;
  if (!slug) return false;
  try {
    const noteHtml = `<p>${text.substring(0, 6000)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\n/g,'</p><p>')}</p>`;
    const lid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    const r = await fetch(
      `https://tt.teamtailor.com/app/companies/${slug}/api/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({
          comment: {
            action_data: { note: noteHtml, rich_text_enabled: true },
            candidate_id: String(candidateId), code: 'note', lid,
            division_id: null, from_stage_id: null, group_meeting_id: null,
            hire_quality_response_id: null, job_application_id: null, job_id: null,
            note: null, pinned: false, private_note: false, private_note_user_ids: [],
            stage_id: null, substitute_approver_id: null, to_stage_id: null,
            todo_state: null, updated_at: new Date().toISOString(), upload: null
          }
        })
      }
    );
    if (r.ok) { console.log('[TT BG] ✅ Note via internal API'); return true; }
    console.warn('[TT BG] internal comment fallback:', r.status);
  } catch(e) { console.warn('[TT BG] internal comment exception:', e); }
  return false;
}

// ── Імпорт кандидата ───────────────────────────────────────
async function importCandidate(candidate) {
  const headers = await ttHeaders();
  const prefs   = await getPrefs();

  const tags = [...(candidate.tags || [])];
  if (prefs.recruiter_tag && !tags.includes(prefs.recruiter_tag)) tags.unshift(prefs.recruiter_tag);
  const source = candidate.source || 'robota.ua';
  if (!tags.includes(source)) tags.push(source);

  const jobId_resolved = candidate.jobId || prefs.default_job_id;

  const urlNoteLines = [
    candidate.robotaUrl ? `Robota.ua: ${candidate.robotaUrl}` : null,
    candidate.workUrl   ? `Work.ua: ${candidate.workUrl}`     : null,
    candidate.resumeUrl ? `Резюме: ${candidate.resumeUrl}`    : null,
  ].filter(Boolean);

  // Pitch = завжди коротка назва джерела (TT API ліміт: 140 символів).
  // Текст резюме → "Lettera di presentazione" (cover-letter на job-application),
  //   або нотатка якщо вакансію не вибрано (блок нижче).
  // Pitch НЕ використовується для тексту резюме.
  const sourcePitch  = candidate.source === 'work.ua' ? 'Work.ua'
                     : candidate.source === 'hh.kz'   ? 'hh.kz'
                     : 'Robota.ua';
  const pitchText    = sourcePitch;
  const jobId_check  = candidate.jobId || prefs.default_job_id;  // чи буде job-application?

  // Визначаємо ids ДО створення кандидата — щоб включити в POST
  const jobId      = candidate.jobId      || prefs.default_job_id;
  const locationId = candidate.locationId || prefs.default_loc_id;
  const deptId     = candidate.deptId     || prefs.default_dept_id;
  const roleId     = candidate.roleId     || prefs.default_role_id;

  const attrs = {
    'first-name': candidate.firstName || 'Невідомо',
    'last-name':  candidate.lastName  || '',
    'phone':      candidate.phone     || null,
    'email':      candidate.email     || null,
    'pitch':      pitchText,
    'sourced':    true,
    'merge':      true,   // TT auto-merge якщо email збігається з існуючим кандидатом
    'tags':       tags
  };
  // picture не передаємо: robota.ua CDN потребує авторизації → TT отримує 403 → 422
  // (сервери TT не мають куки robota.ua, тому будь-який URL звідти — forbidden)
  // resume в POST /candidates: лише transient:/ URI (вже завантажений файл).
  // https:// URL від robota.ua потребують авторизації — TT не може їх скачати самостійно.
  // Авто-завантаження через getfile API нижче обробляє https:// та відсутній файл.
  if (candidate.resumeUrl && /^transient:/i.test(candidate.resumeUrl)) attrs.resume = candidate.resumeUrl;

  // POST /candidates не підтримує roles/departments/locations — вони йдуть через PATCH /relationships після
  const payload = {
    data: { type: 'candidates', attributes: attrs }
  };
  const resp = await fetchWithRetry(`${TT_BASE}/candidates`, {
    method: 'POST', headers, body: JSON.stringify(payload)
  });
  // .catch(() => null): захищає від порожнього тіла відповіді (504/503 timeout, rate-limit тощо)
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = body?.errors?.[0]?.detail || (body ? JSON.stringify(body) : `HTTP ${resp.status}`);
    throw new Error(`TT (${resp.status}): ${detail}`);
  }
  if (!body?.data?.id) {
    throw new Error(`TT: кандидата не створено — порожня відповідь від API (статус ${resp.status}). Спробуйте ще раз.`);
  }

  const cId = body.data.id;

  // Визначаємо ДО post /job-applications: чи буде прикріплено файл резюме.
  // true ТІЛЬКИ якщо є transient:/ URI — тобто файл вже завантажено вручну в модалці.
  // https:// URLs від robota.ua — TT не може їх скачати, авто-завантаження (нижче) вирішує.
  // Авто-завантаження відбувається ПІСЛЯ job-application POST → не блокує cover-letter:
  // при успіху → обидва (файл + cover-letter) в TT; при помилці → cover-letter залишається.
  const _willHaveFile = !!(candidate.resumeUrl && /^transient:/i.test(candidate.resumeUrl));

  let jaId = null;
  if (cId && jobId) {
    try {
      const jaAttrs = {};
      // cover-letter = текст резюме ЛИШЕ якщо файл не буде прикріплено
      if (candidate.resumeText && !_willHaveFile) jaAttrs['cover-letter'] = candidate.resumeText.substring(0, 6000);

      // Роль НЕ передається через API (TT: "role is not allowed" і на candidate, і на job-application)
      // Роль відображається автоматично з налаштувань вакансії в TT
      const jaRels = {
        candidate: { data: { type: 'candidates', id: String(cId) } },
        job:       { data: { type: 'jobs',       id: String(jobId) } }
      };

      const jaResp = await fetchWithRetry(`${TT_BASE}/job-applications`, {
        method: 'POST', headers,
        body: JSON.stringify({
          data: {
            type: 'job-applications',
            attributes: jaAttrs,
            relationships: jaRels
          }
        })
      });
      if (jaResp.ok) {
        const jaBody = await jaResp.json();
        jaId = jaBody?.data?.id || null;
      } else {
        const jaErr = await jaResp.json().catch(() => ({}));
        console.error('job-application error:', jaResp.status, JSON.stringify(jaErr));
      }
    } catch (e) { console.error('job-application exception:', e); }
  }

  // Роль, відділ, локація ─────────────────────────────────────────────────────
  // TT (Rails JSON:API): role/department — сингулярні to-one, локація — to-many POST
  if (cId) {
    // department (сингулярний to-one)
    if (deptId) {
      try {
        const r = await fetchWithRetry(`${TT_BASE}/candidates/${cId}/relationships/department`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ data: { type: 'departments', id: String(deptId) } })
        });
        if (!r.ok) { const e = await r.json().catch(()=>({})); console.error('TT dept:', r.status, JSON.stringify(e)); }
      } catch(e) { console.error('TT dept exception:', e); }
    }
    // locations — to-many: POST (додати) замість PATCH (замінити всі → 403)
    if (locationId) {
      try {
        const r = await fetchWithRetry(`${TT_BASE}/candidates/${cId}/relationships/locations`, {
          method: 'POST', headers,
          body: JSON.stringify({ data: [{ type: 'locations', id: String(locationId) }] })
        });
        if (!r.ok) { const e = await r.json().catch(()=>({})); console.error('TT location:', r.status, JSON.stringify(e)); }
      } catch(e) { console.error('TT location exception:', e); }
    }
  }

  // ── Коментар рекрутера ────────────────────────────────────────────────────
  // POST /v1/notes (офіційний API) → fallback до internal API → fallback до cover-letter.
  if (cId && candidate.comment) {
    const commentText = candidate.comment.trim();
    const noteSaved = await createTTNote(cId, `💬 Коментар рекрутера:\n${commentText}`, headers);

    // Fallback: PATCH job-application cover-letter (якщо notes API не спрацював)
    if (!noteSaved && jaId) {
      try {
        const fullCL = `💬 Коментар рекрутера:\n${commentText}`;
        const pR = await fetchWithRetry(`${TT_BASE}/job-applications/${jaId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            data: { type: 'job-applications', id: String(jaId),
                    attributes: { 'cover-letter': fullCL.substring(0, 6000) } }
          })
        });
        if (!pR.ok) {
          const t = await pR.text().catch(()=>'');
          console.error('[TT BG] comment cover-letter fallback:', pR.status, t);
        }
      } catch(e) { console.error('[TT BG] comment fallback exception:', e); }
    }
  }

  // ── Резюме як нотатка (якщо немає вакансії і jaId = null) ──────────────────
  // Без job-application немає cover-letter. Pitch = 140 символів (max).
  // Повний текст резюме → POST /v1/notes (офіційний API).
  if (cId && !jaId && candidate.resumeText && candidate.resumeText.trim().length > 140) {
    await createTTNote(cId, candidate.resumeText.trim(), headers);
  }

  // Кастомні поля (кешовано — не робимо GET на кожен імпорт)
  if (cId) {
    const robotaCfName = (prefs.robota_cf_name || 'robota_ua').toLowerCase().trim();
    const workCfName   = (prefs.work_cf_name   || 'work_ua'  ).toLowerCase().trim();
    const fields = await getCustomFields();
    for (const cf of fields) {
      const apiName = (cf.attributes?.['api-name'] || '').toLowerCase();
      const name    = (cf.attributes?.['name']     || '').toLowerCase();
      if ((apiName === robotaCfName || name === robotaCfName) && candidate.robotaUrl) {
        await setCustomField(cId, cf.id, candidate.robotaUrl, headers);
      }
      if ((apiName === workCfName || name === workCfName) && candidate.workUrl) {
        await setCustomField(cId, cf.id, candidate.workUrl, headers);
      }
    }
  }

  // ── PATCH резюме якщо URL вже отримано вручну (кнопка ⬇️ в модалці) ────────
  // Лише transient:/ URI: файл вже завантажено до TT через ROBOTA_UPLOAD_RESUME.
  // https:// URL від robota.ua пропускаємо — авто-завантаження нижче обробить їх через getfile API.
  if (cId && candidate.resumeUrl && /^transient:/i.test(candidate.resumeUrl)) {
    try {
      const patchR = await fetchWithRetry(`${TT_BASE}/candidates/${cId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          data: { type: 'candidates', id: String(cId), attributes: { resume: candidate.resumeUrl } }
        })
      });
      if (patchR.ok) {
        console.log('[TT BG] ✅ Резюме прикріплено (manual URL):', candidate.resumeUrl);
      } else {
        const pe = await patchR.json().catch(() => ({}));
        console.warn('[TT BG] PATCH resume (manual) failed:', patchR.status, JSON.stringify(pe));
      }
    } catch (e) { console.warn('[TT BG] PATCH resume (manual) exception:', e); }
  }

  // ── Авто-завантаження файлу резюме з robota.ua ────────────────────────────
  // Є numericApplyId + resumeType + не NoCvApply → завантажуємо через getfile API.
  // Interaction без resumeId → пропускаємо (getfile не підтримує Interaction без resumeId).
  // Блокуємо лише якщо вже є transient:/ URI (файл вже завантажено вручну в модалці).
  // https:// URL від robota.ua НЕ блокують — TT не може їх скачати сам, ми скачуємо тут.
  const _shouldAutoDownload = cId
    && !(candidate.resumeUrl && /^transient:/i.test(candidate.resumeUrl))
    && candidate.numericApplyId && String(candidate.numericApplyId).trim()
    && candidate.resumeType && candidate.resumeType !== 'NoCvApply'
    && !(candidate.resumeType === 'Interaction' && !candidate.resumeId);
  if (_shouldAutoDownload) {
    try {
      const rToken = await getRobotaToken();
      if (rToken) {
        console.log('[TT BG] 📄 Авто-завантаження резюме для кандидата', cId,
                    '| applyId:', candidate.numericApplyId,
                    '| resumeId:', candidate.resumeId || '(немає)',
                    '| type:', candidate.resumeType);
        let fileData = await robotaGetApplyFile(
          String(candidate.numericApplyId),
          candidate.resumeType,
          rToken,
          candidate.strApplyId || '',
          candidate.resumeId   || ''    // resumeId для Selected/Interaction типів
        );

        // CVDB-fallback: getfile повертає 500 для CVDB resume ID.
        // Якщо є https:// resumeUrl (з GET /resume/{id} відповіді) — завантажуємо напряму.
        if (!fileData?.base64 && candidate.resumeUrl && /^https?:\/\//i.test(candidate.resumeUrl)) {
          console.log('[TT BG] 📄 CVDB direct fallback:', candidate.resumeUrl);
          try {
            const _r = await fetch(candidate.resumeUrl, {
              headers: {
                'Authorization': `Bearer ${rToken}`,
                'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
              }
            });
            console.log('[TT BG] CVDB direct ←', _r.status);
            if (_r.ok) {
              const _ct  = (_r.headers.get('content-type') || '').split(';')[0].trim() || 'application/pdf';
              const _ab  = await _r.arrayBuffer();
              if (_ab.byteLength) {
                const _u8 = new Uint8Array(_ab);
                let _bin = '';
                _u8.forEach(b => { _bin += String.fromCharCode(b); });
                const _mimeExt = {
                  'application/pdf': 'pdf',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                  'application/msword': 'doc', 'application/rtf': 'rtf', 'text/plain': 'txt'
                };
                fileData = {
                  base64:   btoa(_bin),
                  mimeType: _ct,
                  fileName: `resume_${candidate.numericApplyId}.${_mimeExt[_ct] || 'pdf'}`
                };
                console.log('[TT BG] CVDB direct OK: type:', fileData.mimeType, 'size:', _ab.byteLength, 'b');
              }
            }
          } catch (e) { console.warn('[TT BG] CVDB direct fallback exception:', e); }
        }

        if (fileData?.base64) {
          const fileUrl = await uploadResumeToTT(
            fileData.base64,
            fileData.mimeType,
            fileData.fileName || 'resume.pdf',
            cId
          );
          if (fileUrl) {
            // PATCH кандидата — прикріплюємо файл резюме
            const patchR = await fetchWithRetry(`${TT_BASE}/candidates/${cId}`, {
              method: 'PATCH', headers,
              body: JSON.stringify({
                data: { type: 'candidates', id: String(cId), attributes: { resume: fileUrl } }
              })
            });
            if (patchR.ok) {
              console.log('[TT BG] ✅ Резюме авто-прикріплено до кандидата:', fileUrl);
            } else {
              const pe = await patchR.json().catch(() => ({}));
              console.warn('[TT BG] PATCH resume failed:', patchR.status, JSON.stringify(pe));
            }
          } else {
            console.warn('[TT BG] uploadResumeToTT → URL не отримано');
          }
        } else {
          console.warn('[TT BG] robotaGetApplyFile → файл не отримано (всі спроби вичерпано)');
        }
      }
    } catch (e) { console.warn('[TT BG] Авто-завантаження резюме помилка:', e); }
  }

  // ── Авто-завантаження файлу резюме з work.ua (Basic Auth fallback) ────────────
  // Блокуємо лише якщо файл вже завантажено вручну (transient:/ URI), НЕ будь-яким https:// URL.
  // candidateId (= responseId на більшості сторінок) потрібен як fallback для /resumes/{id}
  // resumeId > candidateId > responseId — для fallback /resumes/{id} endpoint
  const _workCandidateId = String(candidate.resumeId || candidate.candidateId || candidate.responseId || '');
  const _shouldAutoDownloadWork = cId
    && !(candidate.resumeUrl && /^transient:/i.test(candidate.resumeUrl))
    && candidate.withFile
    && (candidate.jobId || _workCandidateId)  // jobId може бути відсутній на "всі кандидати"
    && (candidate.responseId || _workCandidateId);
  if (_shouldAutoDownloadWork) {
    try {
      console.log('[TT BG] 📄 Авто-завантаження резюме work.ua | jobId:', candidate.jobId,
                  '| responseId:', candidate.responseId, '| candidateId:', _workCandidateId);
      const fileData = await workDownloadResume(
        String(candidate.jobId || ''),
        String(candidate.responseId || _workCandidateId),
        _workCandidateId
      );
      if (fileData?.base64) {
        const mimeExts = {
          'application/pdf': 'pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
          'application/msword': 'doc',
          'application/rtf': 'rtf',
          'text/plain': 'txt'
        };
        const ext = mimeExts[fileData.mimeType] || 'pdf';
        // Пріоритет: реальне ім'я з Content-Disposition → згенероване ім'я
        const fileName = fileData.fileName || `resume_work_${candidate.jobId}_${candidate.responseId}.${ext}`;
        const fileUrl = await uploadResumeToTT(fileData.base64, fileData.mimeType, fileName, cId);
        if (fileUrl) {
          const patchR = await fetchWithRetry(`${TT_BASE}/candidates/${cId}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({
              data: { type: 'candidates', id: String(cId), attributes: { resume: fileUrl } }
            })
          });
          if (patchR.ok) {
            console.log('[TT BG] ✅ Резюме work.ua авто-прикріплено до кандидата:', fileUrl);
          } else {
            const pe = await patchR.json().catch(() => ({}));
            console.warn('[TT BG] PATCH resume work.ua failed:', patchR.status, JSON.stringify(pe));
          }
        }
      } else {
        console.log('[TT BG] work.ua авто-завантаження: файл недоступний (2FA або відсутній)');
      }
    } catch (e) { console.warn('[TT BG] work.ua auto-download exception:', e); }
  }

  const ttUrl  = `https://app.teamtailor.com/candidates/${cId}`;
  const ttName = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();

  // ── Зберігаємо маппінг в backend-кеші після успішного імпорту ──
  // Формат: "robota:{applyId}" або "work:{candidateId/responseId}"
  if (candidate.source === 'work.ua') {
    // Зберігаємо під candidateId (для /resumes/{id} сторінок)
    if (candidate.candidateId) {
      backendSaveMapping(`work:${candidate.candidateId}`, cId, ttName, ttUrl);
    }
    // Також під responseId якщо він відрізняється (для /applicants/{id} сторінок)
    if (candidate.responseId && candidate.responseId !== candidate.candidateId) {
      backendSaveMapping(`work:${candidate.responseId}`, cId, ttName, ttUrl);
    }
  } else if (candidate.numericApplyId) {
    backendSaveMapping(`robota:${candidate.numericApplyId}`, cId, ttName, ttUrl);
    // Також зберігаємо під strApplyId для прямого пошуку
    if (candidate.strApplyId && candidate.strApplyId !== candidate.numericApplyId) {
      backendSaveMapping(`robota:${candidate.strApplyId}`, cId, ttName, ttUrl);
    }
  }

  // ── Позначаємо резюме в robota.ua як "додано до ATS" ──
  // PUT /resume/ats/{resumeId} — показує ATS-індикатор на картці у robota.ua.
  // Тільки для robota.ua кандидатів з відомим resumeId.
  // Fire-and-forget: не блокуємо відповідь якщо robota.ua недоступна.
  if (candidate.source !== 'work.ua' && candidate.resumeId) {
    getRobotaToken().then(tok => {
      if (tok) robotaMarkResumeAts(candidate.resumeId, tok);
    }).catch(() => {});
  }

  return { candidateId: cId, url: ttUrl };
}

// ── Оновлення існуючого кандидата в TT ────────────────────
async function updateTTCandidate(ttId, candidate) {
  const headers = await ttHeaders();
  const prefs   = await getPrefs();

  // Отримуємо поточні теги кандидата щоб не затерти їх при оновленні
  let currentTags = [];
  try {
    const r = await fetchWithRetry(`${TT_BASE}/candidates/${ttId}`, { headers });
    if (r.ok) {
      const b = await r.json();
      currentTags = b?.data?.attributes?.tags || [];
    }
  } catch(e) {}

  // Додаємо recruiter_tag якщо є і ще не стоїть
  const recruiterTag = (prefs.recruiter_tag || '').trim();
  if (recruiterTag && !currentTags.includes(recruiterTag)) {
    currentTags = [recruiterTag, ...currentTags];
  }

  // Оновлюємо лише непорожні поля — не перезаписуємо наявні дані порожніми значеннями
  const attrs = {};
  if (candidate.firstName) attrs['first-name'] = candidate.firstName;
  if (candidate.lastName)  attrs['last-name']  = candidate.lastName;
  if (candidate.phone)     attrs['phone']       = candidate.phone;
  if (candidate.email)     attrs['email']       = candidate.email;
  // picture не передаємо (robota.ua CDN → 403 для серверів TT)
  if (currentTags.length)  attrs['tags']        = currentTags;

  const patchR = await fetchWithRetry(`${TT_BASE}/candidates/${ttId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      data: { type: 'candidates', id: String(ttId), attributes: attrs }
    })
  });

  if (!patchR.ok) {
    const e = await patchR.json().catch(() => ({}));
    throw new Error(`TT PATCH (${patchR.status}): ${e?.errors?.[0]?.detail || JSON.stringify(e)}`);
  }

  // Додаємо нотатку про оновлення профілю (POST /v1/notes офіційний API)
  const sourceLabel = candidate.source === 'work.ua' ? 'Work.ua' : 'Robota.ua';
  const noteLines = [
    `♻️ Профіль оновлено з ${sourceLabel}`,
    candidate.robotaUrl ? `Robota.ua: ${candidate.robotaUrl}` : null,
    candidate.workUrl   ? `Work.ua: ${candidate.workUrl}`     : null,
    candidate.comment   ? `\n💬 Коментар рекрутера:\n${candidate.comment.trim()}` : null,
  ].filter(Boolean).join('\n');
  await createTTNote(ttId, noteLines, headers);

  // Кастомні поля — оновлюємо при "Оновити профіль" (аналогічно importCandidate)
  const _updPrefs = await getPrefs();
  const _robotaCf = (_updPrefs.robota_cf_name || 'robota_ua').toLowerCase().trim();
  const _workCf   = (_updPrefs.work_cf_name   || 'work_ua'  ).toLowerCase().trim();
  const _fields   = await getCustomFields();
  for (const cf of _fields) {
    const _an = (cf.attributes?.['api-name'] || '').toLowerCase();
    const _nm = (cf.attributes?.['name']     || '').toLowerCase();
    if ((_an === _robotaCf || _nm === _robotaCf) && candidate.robotaUrl) {
      await setCustomField(ttId, cf.id, candidate.robotaUrl, headers);
    }
    if ((_an === _workCf || _nm === _workCf) && candidate.workUrl) {
      await setCustomField(ttId, cf.id, candidate.workUrl, headers);
    }
  }

  return { candidateId: ttId, url: `https://app.teamtailor.com/candidates/${ttId}` };
}

async function setCustomField(candidateId, cfId, value, headers) {
  try {
    const listR = await fetchWithRetry(
      `${TT_BASE}/custom-field-values?filter[owner_id]=${candidateId}&filter[custom_field_id]=${cfId}`,
      { headers }
    );
    if (listR.ok) {
      const lb = await listR.json();
      const existing = lb?.data?.[0];
      if (existing) {
        await fetchWithRetry(`${TT_BASE}/custom-field-values/${existing.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ data: { type: 'custom-field-values', id: String(existing.id), attributes: { value } } })
        });
        return;
      }
    }
    await fetchWithRetry(`${TT_BASE}/custom-field-values`, {
      method: 'POST', headers,
      body: JSON.stringify({ data: { type: 'custom-field-values', attributes: { value }, relationships: {
        owner:          { data: { type: 'candidates',    id: String(candidateId) } },
        'custom-field': { data: { type: 'custom-fields', id: String(cfId) } }
      }}})
    });
  } catch (e) { console.warn('[TT BG] setCustomField exception:', e); }
}

// ── Кеш custom fields (щоб не робити GET /custom-fields на кожен імпорт) ───
let _customFieldsCache    = null;
let _customFieldsCacheTime = 0;
const CUSTOM_FIELDS_TTL   = 10 * 60 * 1000; // 10 хвилин

async function getCustomFields() {
  if (_customFieldsCache && Date.now() - _customFieldsCacheTime < CUSTOM_FIELDS_TTL) {
    return _customFieldsCache;
  }
  // TT API max page[size]=30, пагінація курсорна через links.next (page[after]=cursor).
  // page[number] не підтримується — використовуємо next-link з відповіді.
  const _allCf = [];
  const headers = await ttHeaders();
  let nextUrl = `${TT_BASE}/custom-fields?page[size]=30`;
  for (let i = 0; i < 10 && nextUrl; i++) {
    try {
      const r = await fetchWithRetry(nextUrl, { headers });
      if (!r.ok) break;
      const body = await r.json();
      const batch = body?.data || [];
      if (!batch.length) break;
      _allCf.push(...batch);
      nextUrl = body?.links?.next || null; // null = остання сторінка
    } catch { break; }
  }
  _customFieldsCache     = _allCf;
  _customFieldsCacheTime = Date.now();
  return _customFieldsCache;
}

// ── Robota.ua API ──────────────────────────────────────────

// In-memory кеш токена (живе поки service worker активний)
let _robotaToken     = null;
let _robotaTokenTime = 0;
const ROBOTA_TOKEN_TTL = 22 * 60 * 60 * 1000; // 22 години

// ── Автоматичне захоплення JWT через перехоплення запитів robota.ua ──
// robota.ua Angular-додаток НЕ зберігає JWT в localStorage (лише 4 службових ключі).
// Натомість він відправляє Bearer-токен у Authorization заголовку кожного запиту.
// Ми перехоплюємо ці запити та кешуємо токен — без жодної взаємодії з користувачем.
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      const authHeader = (details.requestHeaders || []).find(h =>
        h.name.toLowerCase() === 'authorization' &&
        h.value && h.value.startsWith('Bearer eyJ')
      );
      if (authHeader) {
        const token = authHeader.value.slice(7); // прибираємо 'Bearer '
        if (token.length > 50 && token !== _robotaToken) {
          console.log('[TT BG] 🔑 JWT перехоплено автоматично:', token.substring(0, 30) + '…');
          _robotaToken     = token;
          _robotaTokenTime = Date.now();
          chrome.storage.local.set({ robota_token: token, robota_token_time: Date.now() });
        }
      }
    } catch (e) {}
  },
  { urls: ['*://employer-api.robota.ua/*', '*://auth-api.robota.ua/*'] },
  ['requestHeaders', 'extraHeaders']  // extraHeaders обов'язковий для перехоплення Authorization
);

// ── hh.kz — перехоплення Bearer токена ────────────────────
// hh.kz SPA робить запити до api.hh.ru з Authorization: Bearer ...
// Перехоплюємо токен автоматично — без жодної взаємодії з користувачем.
let _hhToken     = null;
let _hhTokenTime = 0;
const HH_TOKEN_TTL = 23 * 60 * 60 * 1000; // 23 год (access_token живе ~24 год)

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      const authHeader = (details.requestHeaders || []).find(h =>
        h.name.toLowerCase() === 'authorization' &&
        h.value && h.value.startsWith('Bearer ')
      );
      if (authHeader) {
        const token = authHeader.value.slice(7);
        if (token.length > 50 && token !== _hhToken) {
          console.log('[TT BG] 🔑 hh.kz токен перехоплено:', token.substring(0, 30) + '…');
          _hhToken     = token;
          _hhTokenTime = Date.now();
          chrome.storage.local.set({ hh_token: token, hh_token_time: Date.now() });
        }
      }
    } catch (e) {}
  },
  { urls: ['*://api.hh.ru/*', '*://api.hh.kz/*'] },
  ['requestHeaders', 'extraHeaders']
);

async function getHhToken() {
  if (_hhToken && Date.now() - _hhTokenTime < HH_TOKEN_TTL) return _hhToken;
  // Спробувати з storage (між сесіями браузера)
  const prefs = await getPrefs();
  if (prefs.hh_token && prefs.hh_token_time &&
      Date.now() - prefs.hh_token_time < HH_TOKEN_TTL) {
    _hhToken     = prefs.hh_token;
    _hhTokenTime = prefs.hh_token_time;
    return _hhToken;
  }
  return null;
}

async function hhApiFetch(path, params = {}) {
  const token = await getHhToken();
  if (!token) throw new Error('hh.kz токен не знайдено — відкрийте будь-яку сторінку hh.kz');
  const url = new URL('https://api.hh.ru' + path);
  if (!url.searchParams.has('host')) url.searchParams.set('host', 'hh.kz');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization':  `Bearer ${token}`,
      'HH-User-Agent':  'Teamtailor Importera/5.1.2 (support@yourcompany.com)',
      'Accept':         'application/json'
    }
  });
  if (resp.status === 401) {
    _hhToken = null;
    chrome.storage.local.remove(['hh_token', 'hh_token_time']);
    throw new Error('hh.kz токен застарів');
  }
  if (!resp.ok) throw new Error(`hh.kz API ${resp.status}: ${path}`);
  return resp.json();
}

// Отримати всі відгуки по вакансії: спочатку колекції, потім елементи кожної
async function hhGetAllNegotiations(vacancyId) {
  const collectionsResp = await hhApiFetch('/negotiations', { vacancy_id: vacancyId });
  const collections = collectionsResp?.collections || [];
  const all = [];
  for (const col of collections) {
    if (!col.url || (col.counters?.total || 0) === 0) continue;
    try {
      // URL вже містить vacancy_id, беремо лише path+search
      const colUrl  = new URL(col.url);
      const colPath = colUrl.pathname;
      const colParams = {};
      colUrl.searchParams.forEach((v, k) => { if (k !== 'host') colParams[k] = v; });
      let page = 0;
      while (true) {
        const data = await hhApiFetch(colPath, { ...colParams, page, per_page: 50 });
        if (!data?.items?.length) break;
        all.push(...data.items);
        if (all.length >= (data.found || 0) || data.items.length < 50) break;
        page++;
      }
    } catch (e) {
      console.warn('[TT BG] hhGetAllNegotiations col error:', col.id, e.message);
    }
  }
  return all;
}

// Отримати повне резюме з контактами (topic_id потрібен щоб не списувати контакт повторно)
async function hhGetResume(resumeId, topicId) {
  const params = { host: 'hh.kz' };
  if (topicId) params.topic_id = topicId;
  return hhApiFetch(`/resumes/${resumeId}`, params);
}

// Авторизація через логін/пароль → повертає токен або null
async function robotaLoginWithCredentials(username, password) {
  try {
    const r = await fetch('https://auth-api.robota.ua/Login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password, remember: true })
    });
    if (!r.ok) { console.warn('robotaLogin:', r.status); return null; }
    const text = await r.text();
    // API може повернути рядок "token" або об'єкт {token: "..."}
    try {
      const parsed = JSON.parse(text.trim());
      return typeof parsed === 'string' ? parsed : (parsed?.token || parsed?.access_token || null);
    } catch { return null; }
  } catch (e) { console.warn('robotaLogin exception:', e); return null; }
}

// Отримати токен: кеш → storage → cookie браузера → логін через credentials
async function getRobotaToken() {
  // 1. In-memory кеш
  if (_robotaToken && Date.now() - _robotaTokenTime < ROBOTA_TOKEN_TTL) {
    console.log('[TT BG] getRobotaToken → in-memory cache ✅');
    return _robotaToken;
  }

  // 2. Токен збережений у storage (наприклад після кнопки "Перевірити" в options)
  const prefs = await getPrefs();
  if (prefs.robota_token && prefs.robota_token_time &&
      Date.now() - prefs.robota_token_time < ROBOTA_TOKEN_TTL) {
    console.log('[TT BG] getRobotaToken → storage ✅ (вік:', Math.round((Date.now()-prefs.robota_token_time)/3600000), 'год)');
    _robotaToken     = prefs.robota_token;
    _robotaTokenTime = prefs.robota_token_time;
    return _robotaToken;
  }

  // 3. Cookie-сканування — перевіряємо ВСІ cookie robota.ua на JWT-формат (eyJ...)
  const allCookies = await new Promise(resolve => {
    chrome.cookies.getAll({ url: 'https://robota.ua' }, cookies => resolve(cookies || []));
  });
  console.log('[TT BG] cookies robota.ua:', allCookies.map(c => `${c.name}=${c.value.substring(0,10)}…`));
  for (const c of allCookies) {
    if (c.value && c.value.length > 50 && c.value.startsWith('eyJ')) {
      console.log('[TT BG] getRobotaToken → cookie JWT ✅:', c.name);
      _robotaToken = c.value; _robotaTokenTime = Date.now();
      return _robotaToken;
    }
  }
  const wwwCookies = await new Promise(resolve => {
    chrome.cookies.getAll({ url: 'https://www.robota.ua' }, cookies => resolve(cookies || []));
  });
  for (const c of wwwCookies) {
    if (c.value && c.value.length > 50 && c.value.startsWith('eyJ')) {
      console.log('[TT BG] getRobotaToken → www cookie JWT ✅:', c.name);
      _robotaToken = c.value; _robotaTokenTime = Date.now();
      return _robotaToken;
    }
  }

  // 4. Логін через збережені credentials
  const login    = (prefs.robota_login    || '').trim();
  const password = (prefs.robota_password || '').trim();
  if (!login || !password) {
    console.warn('[TT BG] getRobotaToken → ❌ no token, no credentials');
    return null;
  }

  console.log('[TT BG] getRobotaToken → спроба логіну через credentials...');
  const token = await robotaLoginWithCredentials(login, password);
  if (token) {
    console.log('[TT BG] getRobotaToken → credentials login ✅');
    _robotaToken     = token;
    _robotaTokenTime = Date.now();
    chrome.storage.local.set({ robota_token: token, robota_token_time: Date.now() });
  } else {
    console.error('[TT BG] getRobotaToken → ❌ credentials login failed');
  }
  return token || null;
}

// Safe JSON parse — повертає null замість SyntaxError при порожньому тілі
async function safeJson(r) {
  try {
    const text = await r.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch (e) { return null; }
}

async function robotaGetResume(resumeId, token) {
  try {
    console.log(`[TT BG] GET /resume/${resumeId} (token: ${token ? token.substring(0,20)+'…' : 'NONE'})`);
    const r = await fetchWithRetry(`${ROBOTA_API}/resume/${resumeId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      signal: AbortSignal.timeout(20000)
    }, 2);
    console.log(`[TT BG] GET /resume/${resumeId} → ${r.status}`);
    if (!r.ok) { console.warn(`robotaGetResume(${resumeId}):`, r.status); return null; }
    return safeJson(r);
  } catch (e) { console.warn('robotaGetResume exception:', e); return null; }
}

async function robotaOpenContacts(resumeId, token, extraBody = {}) {
  try {
    // Новий endpoint (старий /resume/open/{id} — перекреслений у Swagger)
    const endpoint = `${ROBOTA_API}/resume/${resumeId}/contacts/visibility`;
    console.log(`[TT BG] POST /resume/${resumeId}/contacts/visibility`);
    const r = await fetchWithRetry(endpoint, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      body:   JSON.stringify(extraBody),
      signal: AbortSignal.timeout(15000)
    }, 2);
    console.log(`[TT BG] POST /resume/${resumeId}/contacts/visibility → ${r.status}`);
    if (!r.ok) { console.warn(`robotaOpenContacts(${resumeId}):`, r.status); return null; }
    // API може повернути рядок "ContactsWereAlreadyOpened" або JSON з контактами
    const text = await r.text().catch(() => '');
    if (!text || text.trim() === 'ContactsWereAlreadyOpened') return { alreadyOpened: true };
    try { return JSON.parse(text); } catch { return { alreadyOpened: true }; }
  } catch (e) { console.warn('robotaOpenContacts exception:', e); return null; }
}

// Отримати деталі одного відгуку (applyId має бути числовим)
// Swagger: POST /apply (GetApply) — офіційний endpoint.
// POST /apply (GetApply) — отримати деталі одного відгуку.
// ВАЖЛИВО: використовуємо plain fetch (не fetchWithRetry) — на 500/404 не робимо retry,
// щоб не флудити сервер. ID із 500/404 кешуємо щоб не повторювати.
const _robotaApplyErrorCache = new Set(); // ID що повернули 4xx/5xx

async function robotaGetApply(applyId, token) {
  const _idStr = String(applyId);
  if (!_idStr || !/^\d+$/.test(_idStr)) return null;
  if (_robotaApplyErrorCache.has(_idStr)) return null; // вже знаємо — не повторюємо
  try {
    console.log(`[TT BG] POST /apply id=${applyId}`);
    const r = await fetch(`${ROBOTA_API}/apply`, {   // plain fetch — no retry on error
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      body: JSON.stringify({ id: Number(_idStr) }),
      signal: AbortSignal.timeout(15000)
    });
    console.log(`[TT BG] POST /apply → ${r.status}`);
    if (!r.ok) {
      _robotaApplyErrorCache.add(_idStr); // кешуємо — не повторюємо цей ID
      console.warn(`robotaGetApply(${applyId}):`, r.status);
      return null;
    }
    const data = await safeJson(r);
    // ── ДІАГНОСТИКА: структура відповіді
    try {
      const d = data?.data || data;
      console.log('[TT BG] GET_ROBOTA_APPLY ключі:', Object.keys(d || {}));
      console.log('[TT BG] GET_ROBOTA_APPLY id/resumeId:', d?.id, '/', d?.resumeId || d?.resume_id);
    } catch (_) {}
    return data;
  } catch (e) { console.warn('robotaGetApply exception:', e); return null; }
}

// Позначити резюме як "додано до ATS" у robota.ua
// Swagger: PUT /resume/ats/{id} — встановлює ATS-індикатор на картці резюме.
// Викликається після успішного імпорту до TT.
async function robotaMarkResumeAts(resumeId, token) {
  if (!resumeId || !/^\d+$/.test(String(resumeId))) return;
  try {
    const r = await fetch(`${ROBOTA_API}/resume/ats/${resumeId}`, {
      method:  'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      signal: AbortSignal.timeout(5000)
    });
    console.log(`[TT BG] PUT /resume/ats/${resumeId} → ${r.status}`);
  } catch (e) { console.warn('[TT BG] robotaMarkResumeAts exception:', e); }
}

// candidateTypes — всі типи кандидатів, що підтримуються API:
// Application=без резюме, ApplicationWithResume=онлайн резюме, ApplicationWithFile=файл,
// SelectedResume=збережені з бази, VacancyInteraction=взаємодія,
// Recommended=рекомендовані, VacancyOffered=запропоновані.
// API docs (2025): GUID→INT тепер автоматичний для Interaction/Recommended/Offered.
// folderId: 0=всі, 1=непереглянуті, 2=переглянуті, 3=цікаві, 4=подумати,
//           5=нецікаві, 6=запрошені, 7=відмовлені, 10=найняті.
const ROBOTA_CANDIDATE_TYPES = [
  'Application', 'ApplicationWithResume', 'ApplicationWithFile',
  'SelectedResume', 'VacancyInteraction', 'Recommended', 'VacancyOffered'
];

async function robotaGetApplyList(vacancyId, token, page = 0) {
  try {
    console.log(`[TT BG] POST /apply/list vacancyId=${vacancyId} page=${page}`);
    const body = vacancyId
      ? { vacancyId: Number(vacancyId), folderId: 0, page, filter: '', candidateTypes: ROBOTA_CANDIDATE_TYPES }
      : { folderId: 0, page, filter: '', candidateTypes: ROBOTA_CANDIDATE_TYPES };
    const r = await fetchWithRetry(`${ROBOTA_API}/apply/list`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      body: JSON.stringify(body)
    });
    console.log(`[TT BG] POST /apply/list → ${r.status}`);
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[TT BG] apply/list error body:`, errText.substring(0, 200));
      return null;
    }
    const data = await safeJson(r);
    const _items = data?.items || data?.applies || data?.candidates || data?.data || data?.results || data?.list || (Array.isArray(data) ? data : null);
    const count = _items?.length ?? '?';
    console.log(`[TT BG] apply/list → ${count} записів`);
    // ── ДІАГНОСТИКА: показуємо структуру відповіді (верхній рівень ключів + перший елемент)
    try {
      // Діагностика: перший елемент (GUID→INT вже автоматичний з боку API)
      const firstItems = data?.applies || data?.items || data?.candidates
                      || data?.data   || data?.results || data?.list
                      || (Array.isArray(data) ? data : null);
      if (firstItems?.length) {
        const fi = firstItems[0];
        console.log('[TT BG] apply/list перший елемент ключі:', Object.keys(fi || {}));
        console.log('[TT BG] apply/list перший елемент id/resumeType/candidateType:',
          fi?.id, '/', fi?.resumeType || fi?.resume_type, '/', fi?.candidateType);
      }
    } catch (_) {}
    return data;
  } catch (e) { console.error('[TT BG] apply/list exception:', e); return null; }
}

// Переглянути відгук — POST /apply/view/{id}?resumeType={type}
// Позначає відгук як переглянутий і повертає контактні дані кандидата
async function robotaGetApplyView(applyId, resumeType, token) {
  try {
    const qs = resumeType ? `?resumeType=${encodeURIComponent(resumeType)}` : '';
    const r = await fetchWithRetry(`${ROBOTA_API}/apply/view/${applyId}${qs}`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
      },
      signal: AbortSignal.timeout(15000)
    }, 2);
    if (!r.ok) { console.warn(`robotaGetApplyView(${applyId}):`, r.status); return null; }
    return safeJson(r);
  } catch (e) { console.warn('robotaGetApplyView exception:', e); return null; }
}

// Завантажити файл резюме — GET /apply/getfile/{id}?resumeType={type}
// Swagger: resumeType = AttachedFile | Notepad | Selected | NoCvApply
// Повертає {base64, mimeType, fileName} або null
// resumeId — для Selected/Interaction кандидатів (ID резюме в CVDB, не applyId)
async function robotaGetApplyFile(applyId, resumeType, token, strApplyId = '', resumeId = '') {
  const rt = resumeType || '';
  const isInteraction = rt.toLowerCase() === 'interaction';
  const urls = [];

  if (isInteraction) {
    // Interaction-тип: getfile не підтримує 'Interaction' як resumeType.
    // isFromCVDB=false → resumeId вказує на онлайн-резюме (Notepad).
    // isFromCVDB=true  → резюме з CVDB (Selected).
    // Пробуємо обидва варіанти: Notepad першим (частіше зустрічається), потім Selected.
    // Порядок ID: resumeId пріоритет (реальне резюме), потім applyId як fallback.
    const interactionIds = [...new Set([resumeId, applyId, strApplyId].filter(Boolean))];
    for (const id of interactionIds) {
      urls.push(`${ROBOTA_API}/apply/getfile/${id}?resumeType=Notepad`);
      urls.push(`${ROBOTA_API}/apply/getfile/${id}?resumeType=Selected`);
    }
    // Без типу — останній fallback
    for (const id of interactionIds) {
      urls.push(`${ROBOTA_API}/apply/getfile/${id}`);
    }
  } else {
    // Звичайні типи: applyId (AttachedFile/Notepad) + resumeId (Selected)
    // Формуємо список: applyId + strApplyId + resumeId (без дублів)
    const allIds = [...new Set([applyId, strApplyId, resumeId].filter(Boolean))];
    for (const id of allIds) {
      if (rt) {
        urls.push(`${ROBOTA_API}/apply/getfile/${id}?resumeType=${encodeURIComponent(rt)}`);
        // Lowercase варіант (robota.ua може бути чутливий до регістру enum)
        if (rt !== rt.toLowerCase()) {
          urls.push(`${ROBOTA_API}/apply/getfile/${id}?resumeType=${encodeURIComponent(rt.toLowerCase())}`);
        }
      }
      // Без resumeType — fallback
      urls.push(`${ROBOTA_API}/apply/getfile/${id}`);
    }
  }

  // Парсимо відповідь (JSON або бінарний)
  async function parseResp(r, id) {
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/')) {
      const json = await safeJson(r);
      if (!json) return null;
      const b64 = json.fileContent || json.base64 || json.content || json.file || json.data || '';
      if (!b64) return null;
      return {
        base64:   b64,
        mimeType: json.mimeType || json.contentType || json.fileType || 'application/pdf',
        fileName: json.fileName || `resume_${id}.pdf`
      };
    }
    const blob       = await r.blob();
    const arrayBuf   = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuf);
    let binary = '';
    uint8Array.forEach(b => { binary += String.fromCharCode(b); });
    const finalMime = ct.split(';')[0].trim() || 'application/pdf';
    // Визначаємо розширення з mimeType — щоб TT правильно відображав файл
    const _mimeExt = {
      'application/pdf':  'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/rtf':  'rtf',
      'text/plain':       'txt'
    };
    const ext = _mimeExt[finalMime] || 'pdf';
    // Беремо реальне ім'я файлу з Content-Disposition якщо є (напр. "Іванов_Олег.pdf")
    const _cdName = _getFilenameFromResponse(r, '');
    return {
      base64:   btoa(binary),
      mimeType: finalMime,
      fileName: _cdName || `resume_${id}.${ext}`
    };
  }

  // CVDB-fallback: /apply/getfile повертає HTTP 500 для CVDB resume ID (не apply-відгуку).
  // Для Selected/Recommended/Interaction пробуємо /resume/{id}/download та /resume/{id}/file.
  if (rt === 'Selected' || rt === 'Recommended' || isInteraction) {
    const _cvdbIds = [...new Set([resumeId, applyId, strApplyId].filter(Boolean))];
    for (const id of _cvdbIds) {
      urls.push(`${ROBOTA_API}/resume/${id}/download`);
      urls.push(`${ROBOTA_API}/resume/${id}/file`);
    }
  }

  for (const url of urls) {
    try {
      console.log(`[TT BG] getfile → ${url}`);
      // plain fetch замість fetchWithRetry — HTTP 500 = неправильний endpoint, не transient error.
      // fetchWithRetry витрачав би ~12 с на кожен 500 (4 retry × exponential backoff).
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)'
        }
      });
      console.log(`[TT BG] getfile ← ${r.status}`);
      if (!r.ok) continue; // пробуємо наступний варіант
      const result = await parseResp(r, applyId);
      if (result) return result;
    } catch (e) { console.warn(`[TT BG] getfile exception (${url}):`, e); }
  }
  console.warn(`[TT BG] robotaGetApplyFile: всі спроби вичерпано для applyId=${applyId}`);
  return null;
}

// ── TT Lists ───────────────────────────────────────────────
// Кешуємо 10 хвилин — модалка відкривається часто, lists рідко змінюються.
// Без кешу: кожне відкриття модалки = 4 запити → лавина 429 при 10+ юзерах.
let _ttListsCache     = null;
let _ttListsCacheTime = 0;
let _ttListsPending   = null; // guard від race condition
const _TT_LISTS_TTL   = 10 * 60 * 1000; // 10 хвилин

async function getTTLists() {
  if (_ttListsCache && Date.now() - _ttListsCacheTime < _TT_LISTS_TTL) {
    return _ttListsCache;
  }
  // Якщо вже є активний fetch — чекаємо його замість нового
  if (_ttListsPending) return _ttListsPending;

  _ttListsPending = (async () => {
    const [jobs, depts, roles, locs] = await Promise.all([
      ttGetList('/jobs?page[size]=30'),
      ttGetList('/departments?page[size]=30'),
      ttGetList('/roles?page[size]=30'),
      ttGetList('/locations?page[size]=30')
    ]);
    _ttListsCache     = { jobs, depts, roles, locs };
    _ttListsCacheTime = Date.now();
    _ttListsPending   = null;
    return _ttListsCache;
  })();

  return _ttListsPending;
}

// ── Завантажити теги рекрутерів з двох джерел ─────────────
// 1. GET /v1/users — реальні користувачі TT (ім'я + роль)
// 2. Унікальні теги з наявних кандидатів (щоб підхопити старі мітки)
// Кешуємо 10 хвилин.
let _ttTagsCache     = null;
let _ttTagsCacheTime = 0;
let _ttTagsPending   = null; // guard від race condition
const _TT_TAGS_TTL   = 10 * 60 * 1000; // 10 хвилин

async function getTTCandidateTags() {
  if (_ttTagsCache && Date.now() - _ttTagsCacheTime < _TT_TAGS_TTL) {
    return _ttTagsCache;
  }
  if (_ttTagsPending) return _ttTagsPending;
  _ttTagsPending = _fetchTTCandidateTags().finally(() => { _ttTagsPending = null; });
  return _ttTagsPending;
}

async function _fetchTTCandidateTags() {
  const headers = await ttHeaders();
  const tags = new Set();

  // ── 1. Користувачі TT (include=role щоб знати посаду) ──
  // Формат тегу: "ім'я (роль)" — наприклад "valentyna (sourcer)"
  // Якщо роль не доступна (Public ключ) — лише "ім'я"
  try {
    let nextUrl = `${TT_BASE}/users?page[size]=30&include=role`;
    while (nextUrl) {
      const r = await fetchWithRetry(nextUrl, { headers });
      if (!r.ok) break;
      const body = await r.json();
      const rolesById = {};
      for (const inc of (body?.included || [])) {
        if (inc.type === 'roles') rolesById[inc.id] = (inc.attributes?.name || '').toLowerCase().trim();
      }
      for (const u of (body?.data || [])) {
        const firstName = (u.attributes?.['first-name'] || '').trim();
        if (!firstName) continue;
        const lastName  = (u.attributes?.['last-name']  || '').trim();
        const roleId    = u.relationships?.role?.data?.id;
        const roleName  = roleId ? rolesById[roleId] : '';
        // Формат: "ім'я прізвище (роль)" або "ім'я прізвище" якщо ролі немає
        const namePart = [firstName, lastName].filter(Boolean).join(' ').toLowerCase();
        const tag = roleName ? `${namePart} (${roleName})` : namePart;
        if (tag) tags.add(tag);
      }
      nextUrl = body?.links?.next || null;
    }
    console.log(`[TT BG] Користувачі TT як теги: ${tags.size}`);
  } catch(e) { console.warn('[TT BG] getTTUsers error:', e); }

  // ── 2. Унікальні теги з кандидатів (підхоплюємо старі мітки) ──
  try {
    let nextUrl = `${TT_BASE}/candidates?page[size]=30&sort=-created-at`;
    for (let p = 0; p < 2 && nextUrl; p++) {
      const r = await fetchWithRetry(nextUrl, { headers });
      if (!r.ok) break;
      const body = await r.json();
      for (const c of (body?.data || [])) {
        for (const t of (c.attributes?.tags || [])) {
          if (t && typeof t === 'string') {
            const low = t.toLowerCase().trim();
            // Пропускаємо джерела (автотеги)
            if (low !== 'robota.ua' && low !== 'work.ua') tags.add(low);
          }
        }
      }
      nextUrl = body?.links?.next || null;
    }
  } catch(e) {}

  _ttTagsCache     = [...tags].sort();
  _ttTagsCacheTime = Date.now();
  console.log(`[TT BG] Всього тегів для вибору: ${_ttTagsCache.length}`);
  return _ttTagsCache;
}

// ════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    sendResponse({ ok: true });
    return false;
  }

  // ── Backend batch-cache handlers ──────────────────────────
  if (msg.type === 'BACKEND_BATCH_CHECK') {
    backendBatchCheck(msg.ids || [])
      .then(result => sendResponse({ ok: true, result }))
      .catch(() => sendResponse({ ok: true, result: {} }));
    return true;
  }

  if (msg.type === 'BACKEND_SAVE') {
    backendSaveMapping(msg.id, msg.ttId, msg.ttName, msg.ttUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'BACKEND_DELETE') {
    backendDeleteMapping(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_TT_LISTS') {
    getTTLists()
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'CHECK_DUPLICATE') {
    _withTtSemaphore(() => checkDuplicate(msg.phone, msg.email, msg.name))
      .then(dupe => sendResponse({ ok: true, dupe }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // PANEL_CHECK_DUPLICATE: пріоритетна перевірка панелі — без семафору.
  // Використовується watchDetailPanel коли реальний телефон/email стає відомий
  // (work.ua приховує контакти до відкриття картки). Одночасно може бути лише
  // 1-2 відкритих панелі → ризику 429 немає.
  if (msg.type === 'PANEL_CHECK_DUPLICATE') {
    _withPanelSemaphore(() => checkDuplicate(msg.phone, msg.email, msg.name))
      .then(dupe => sendResponse({ ok: true, dupe }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'BULK_CHECK_NAMES') {
    (async () => {
      const names = (msg.names || []).filter(Boolean);
      if (!names.length) return sendResponse({ ok: true, results: {} });
      const headers = await ttHeaders();
      if (!headers) return sendResponse({ ok: false, error: 'no token' });

      // Унікальні слова → запити і по filter[last-name], і по filter[first-name]
      const words = new Set();
      for (const n of names) {
        const p = n.trim().split(/\s+/).filter(Boolean);
        if (p.length >= 2) { words.add(p[0]); words.add(p[1]); }
      }
      // Формуємо список запитів: кожне слово × 2 поля
      const queries = [];
      for (const w of words) {
        queries.push(`filter[last-name]=${encodeURIComponent(w)}`);
        queries.push(`filter[first-name]=${encodeURIComponent(w)}`);
      }

      // Послідовні запити з throttle (коректний rate-limit — _ttThrottle не працює в Promise.all)
      const allCandidates = [];
      for (const q of queries) {
        try {
          const r = await fetchWithRetry(`${TT_BASE}/candidates?${q}&page[size]=30`, { headers }, 2);
          if (!r.ok) continue;
          const b = await r.json();
          for (const c of (b?.data || [])) allCandidates.push(c);
        } catch {}
      }

      // Дедублікація по ID
      const seen = new Set();
      const unique = allCandidates.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

      // Збіг для кожного імені
      const results = {};
      for (const n of names) results[n] = ttMatchName(unique, n) || null;
      sendResponse({ ok: true, results });
    })();
    return true;
  }

  if (msg.type === 'COMPARE_WITH_TT') {
    _withTtSemaphore(() => compareWithTT(msg.ttId, msg.candidate))
      .then(result => sendResponse({ ok: true, result }))
      .catch(e     => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_TT_TAGS') {
    getTTCandidateTags()
      .then(tags => sendResponse({ ok: true, tags }))
      .catch(() => sendResponse({ ok: true, tags: [] }));
    return true;
  }

  if (msg.type === 'IMPORT_CANDIDATE') {
    importCandidate(msg.candidate)
      .then(result => sendResponse({ ok: true, result }))
      .catch(e     => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'UPDATE_CANDIDATE') {
    updateTTCandidate(msg.ttId, msg.candidate)
      .then(result => sendResponse({ ok: true, result }))
      .catch(e     => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'OPEN_TT_TABS') {
    // Відкриваємо вкладки TT у фоні. Приймаємо лише app.teamtailor.com URL.
    const urls = Array.isArray(msg.urls)
      ? msg.urls.filter(u => /^https:\/\/app\.teamtailor\.com\//.test(String(u || '')))
      : [];
    urls.forEach(url => chrome.tabs.create({ url, active: false }));
    sendResponse({ ok: true });
    return false;
  }

  // ── Robota.ua API calls ──

  if (msg.type === 'GET_WORK_RESPONSES') {
    // lastId — курсор для пагінації (id останнього елемента попередньої сторінки)
    workGetResponses(msg.jobId, msg.limit || 50, msg.lastId || null)
      .then(data => sendResponse({ ok: !!data, data }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_WORK_ALL_RESPONSES') {
    workGetAllResponses(msg.limit || 50, msg.lastId || null)
      .then(data => sendResponse({ ok: !!data, data }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'WORK_DOWNLOAD_RESUME') {
    workDownloadResume(msg.jobId, msg.responseId, msg.resumeId || msg.candidateId).then(async fileData => {
      if (!fileData) { sendResponse({ ok: false, error: 'Не вдалось завантажити файл' }); return; }
      const url = await uploadResumeToTT(fileData.base64, fileData.mimeType, msg.fileName || fileData.fileName || 'resume.pdf', msg.candidateId);
      sendResponse({ ok: !!url, url });
    });
    return true;
  }

  // Контент-скрипт work.js завантажив файл через браузерну сесію (2FA-friendly),
  // сконвертував у base64 і передає сюди для POST /v1/files → transient:/ URI
  if (msg.type === 'WORK_UPLOAD_RESUME_BASE64') {
    (async () => {
      console.log('[TT BG] WORK_UPLOAD_RESUME_BASE64 | fileName:', msg.fileName,
        '| mimeType:', msg.mimeType, '| base64 len:', msg.base64?.length || 0);
      const url = await uploadResumeToTT(
        msg.base64,
        msg.mimeType || 'application/pdf',
        msg.fileName || 'resume.pdf',
        null
      );
      console.log('[TT BG] WORK_UPLOAD_RESUME_BASE64 → ok:', !!url, 'url:', url);
      sendResponse({ ok: !!url, url: url || null });
    })();
    return true;
  }

  if (msg.type === 'CHECK_WORK_AUTH') {
    workApiGet('/jobs/my?active=1')
      .then(data => sendResponse({ ok: !!data }))
      .catch(e   => sendResponse({ ok: false }));
    return true;
  }

  // Деталі резюме для прямих сторінок /resumes/{id}/ (phone, email, photo)
  if (msg.type === 'GET_WORK_RESUME_DETAIL') {
    workApiGet(`/resumes/${msg.resumeId}`)
      .then(data => sendResponse({ ok: !!data, data }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Деталі одного відгуку /jobs/responses/{id} — phone/email для кандидатів поза preload-кешем
  if (msg.type === 'GET_WORK_RESPONSE_DETAIL') {
    workApiGet(`/jobs/responses/${msg.responseId}`)
      .then(data => sendResponse({ ok: !!data, data }))
      .catch(e   => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Контент-скрипт передає JWT з localStorage (robota.ua Angular SPA)
  if (msg.type === 'CACHE_ROBOTA_TOKEN') {
    if (msg.token && msg.token.length > 50 && msg.token.startsWith('eyJ')) {
      _robotaToken     = msg.token;
      _robotaTokenTime = Date.now();
      chrome.storage.local.set({ robota_token: msg.token, robota_token_time: Date.now() });
      console.log('[TT BG] ✅ CACHE_ROBOTA_TOKEN отримано, токен збережено:', msg.token.substring(0,30)+'…');
    } else {
      console.warn('[TT BG] CACHE_ROBOTA_TOKEN отримано але токен невалідний:', String(msg.token).substring(0,30));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_ROBOTA_TOKEN') {
    getRobotaToken()
      .then(token => sendResponse({ ok: true, token }))
      .catch(e    => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Отримати ПІБ (і опційно файл) через dracula.robota.ua GraphQL.
  // Використовується в robota.js як fallback для ПІБ коли REST не повернув ім'я.
  if (msg.type === 'DRACULA_GET_RESUME_INFO') {
    (async () => {
      const info = await _draculaGetResumeFile(msg.resumeId);
      if (!info) { sendResponse({ ok: false }); return; }
      sendResponse({ ok: true, firstName: info.firstName || '', lastName: info.lastName || '' });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_ROBOTA_RESUME') {
    getRobotaToken().then(async token => {
      if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
      const data = await robotaGetResume(msg.resumeId, token);
      sendResponse({ ok: !!data, data });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'OPEN_ROBOTA_CONTACTS') {
    getRobotaToken().then(async token => {
      if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
      // Pass optional vacancyId / applyId in body
      // vacancyId → число; applyId може бути UUID-рядком — залишаємо як є
      const extra = {};
      if (msg.vacancyId) extra.vacancyId = Number(msg.vacancyId);
      if (msg.applyId)   extra.applyId   = msg.applyId; // не конвертуємо — може бути UUID
      const data = await robotaOpenContacts(msg.resumeId, token, extra);
      sendResponse({ ok: !!data, data });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_ROBOTA_APPLY') {
    getRobotaToken().then(async token => {
      if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
      const data = await robotaGetApply(msg.applyId, token);
      sendResponse({ ok: !!data, data });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_ROBOTA_APPLY_LIST') {
    getRobotaToken().then(async token => {
      if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
      const data = await robotaGetApplyList(msg.vacancyId, token, msg.page || 0);
      sendResponse({ ok: !!data, data });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Переглянути відгук (POST /apply/view/{id}?resumeType=...) — повертає контакти
  if (msg.type === 'GET_ROBOTA_APPLY_VIEW') {
    getRobotaToken().then(async token => {
      if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
      const data = await robotaGetApplyView(msg.applyId, msg.resumeType || '', token);
      sendResponse({ ok: !!data, data });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── hh.kz handlers ───────────────────────────────────────
  if (msg.type === 'HH_TOKEN_STATUS') {
    getHhToken()
      .then(token => sendResponse({ ok: true, hasToken: !!token }))
      .catch(() => sendResponse({ ok: true, hasToken: false }));
    return true;
  }

  if (msg.type === 'HH_GET_NEGOTIATIONS') {
    (async () => {
      try {
        const items = await hhGetAllNegotiations(msg.vacancyId);
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'HH_GET_RESUME') {
    (async () => {
      try {
        const resume = await hhGetResume(msg.resumeId, msg.topicId || null);
        sendResponse({ ok: true, resume });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Завантажити файл резюме + одразу завантажити в TT → повертає TT-url
  if (msg.type === 'ROBOTA_UPLOAD_RESUME') {
    (async () => {
      let fileData = null;

      // ── 1. Dracula GraphQL (primary — Cleverstaff pattern) ──────────────────
      // Спочатку пробуємо getCandidatesResumeFile (applies/candidates сторінки).
      // Потім getResumeFile (CVDB/профіль-сторінки, якщо є resumeId).
      // Обидва повертають base64 PDF або приєднаний файл без додаткових бінарних fetch.
      const _strId = msg.strApplyId || msg.applyId;
      console.log('[TT BG] ROBOTA_UPLOAD_RESUME: dracula try — strApplyId:', _strId, 'resumeId:', msg.resumeId || '(none)');
      fileData = await _draculaGetApplyResumeFile(_strId);
      if (!fileData?.base64 && msg.resumeId) {
        fileData = await _draculaGetResumeFile(msg.resumeId);
      }
      // Якщо dracula повернув лише ім'я без файлу — скидаємо (потрібен саме файл тут)
      if (fileData && !fileData.base64) fileData = null;
      if (fileData?.base64) {
        console.log('[TT BG] ROBOTA_UPLOAD_RESUME: dracula ✓ name:', fileData.fileName);
      }

      // ── 2. REST fallback (employer-api /apply/getfile) ───────────────────────
      if (!fileData?.base64) {
        console.log('[TT BG] ROBOTA_UPLOAD_RESUME: dracula miss → REST fallback');
        const token = await getRobotaToken();
        if (!token) { sendResponse({ ok: false, error: 'Не залогінені на robota.ua' }); return; }
        fileData = await robotaGetApplyFile(msg.applyId, msg.resumeType || '', token, msg.strApplyId || '', msg.resumeId || '');

        // ── 3. CVDB direct URL fallback ───────────────────────────────────────
        if (!fileData?.base64 && msg.resumeUrl && /^https?:\/\//i.test(msg.resumeUrl)) {
          console.log('[TT BG] ROBOTA_UPLOAD_RESUME: CVDB direct fallback:', msg.resumeUrl);
          try {
            const _r = await fetch(msg.resumeUrl, {
              headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Agentify HR Tools (hragentify@gmail.com)' }
            });
            console.log('[TT BG] CVDB direct ←', _r.status);
            if (_r.ok) {
              const _ct = (_r.headers.get('content-type') || '').split(';')[0].trim() || 'application/pdf';
              const _ab = await _r.arrayBuffer();
              if (_ab.byteLength) {
                const _u8 = new Uint8Array(_ab); let _bin = '';
                _u8.forEach(b => { _bin += String.fromCharCode(b); });
                const _ext = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc', 'application/rtf': 'rtf', 'text/plain': 'txt' }[_ct] || 'pdf';
                fileData = { base64: btoa(_bin), mimeType: _ct, fileName: `resume_${msg.applyId}.${_ext}` };
                console.log('[TT BG] CVDB direct OK: type:', fileData.mimeType, 'size:', _ab.byteLength, 'b');
              }
            }
          } catch (e) { console.warn('[TT BG] ROBOTA_UPLOAD_RESUME CVDB direct exception:', e); }
        }
      }

      if (!fileData?.base64) { sendResponse({ ok: false, error: 'Не вдалось отримати файл резюме' }); return; }
      // Якщо є оригінальна назва файлу (з preload, AttachedFile) — використовуємо її
      // Інакше беремо згенероване ім'я з правильним розширенням (docx/pdf тощо)
      const uploadFileName = msg.originalFileName || fileData.fileName || 'resume.pdf';
      const url = await uploadResumeToTT(
        fileData.base64,
        fileData.mimeType,
        uploadFileName,
        msg.candidateId || null
      );
      console.log('[TT BG] ROBOTA_UPLOAD_RESUME → sendResponse ok:', !!url, 'url:', url);
      sendResponse({ ok: !!url, url: url || null });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // Зберігаємо тільки ключі яких ще немає — не перезаписуємо існуючі налаштування
  // при оновленні розширення (onInstalled викликається і на install, і на update).
  const DEFAULTS = {
    tt_api_key:        '',
    recruiter_tag:     '',
    default_job_id:    '',
    default_dept_id:   '',
    default_role_id:   '',
    default_loc_id:    '',
    robota_cf_name:    'robota_ua',
    work_cf_name:      'work_ua',
    robota_login:      '',
    robota_password:   '',
    robota_token:      '',
    robota_token_time: 0,
    backend_url:       '',
    backend_secret:    ''
  };
  chrome.storage.local.get(Object.keys(DEFAULTS), existing => {
    const toSet = {};
    for (const [key, def] of Object.entries(DEFAULTS)) {
      if (!(key in existing) || existing[key] === undefined) toSet[key] = def;
    }
    if (Object.keys(toSet).length) chrome.storage.local.set(toSet);
  });
});

// ── Work.ua API (Basic Auth) ───────────────────────────────
async function getWorkAuthHeader() {
  const prefs = await getPrefs();
  const login    = (prefs.work_login    || '').trim();
  const password = (prefs.work_password || '').trim();
  if (!login || !password) return null;
  return `Basic ${btoa(`${login}:${password}`)}`;
}

async function workApiGet(endpoint) {
  const auth = await getWorkAuthHeader();
  if (!auth) return null;
  try {
    const r = await fetchWithRetry(`https://api.work.ua${endpoint}`, {
      headers: {
        'Authorization': auth,
        'Content-Type':  'application/json',
        'User-Agent':    'Agentify HR Tools (hragentify@gmail.com)',
        'X-Locale':      'uk_UA'
      },
      signal: AbortSignal.timeout(20000)
    }, 2);
    if (!r.ok) return null;
    return r.json();
  } catch (e) { return null; }
}

// API docs: пагінація курсорна — last_id, НЕ offset.
// offset не існує в API і ігнорується сервером → завжди повертає ті самі 50 відгуків.
// Передаємо lastId = id останнього елемента попередньої сторінки (або null для першої).
async function workGetResponses(jobId, limit = 50, lastId = null) {
  const qs = `limit=${limit}${lastId ? `&last_id=${lastId}` : ''}`;
  return workApiGet(`/jobs/${jobId}/responses?${qs}`);
}

// Всі відгуки по всіх вакансіях (не потребує jobId)
async function workGetAllResponses(limit = 50, lastId = null) {
  const qs = `limit=${limit}${lastId ? `&last_id=${lastId}` : ''}`;
  return workApiGet(`/jobs/responses?${qs}`);
}

async function workDownloadResume(jobId, responseId, resumeId) {
  const auth = await getWorkAuthHeader();
  if (!auth) return null;

  // Допоміжна функція: fetch URL → base64 result
  async function _fetchToBase64(url, extraHeaders = {}) {
    try {
      const r = await fetchWithRetry(url, {
        headers: { 'Authorization': auth, 'User-Agent': 'Agentify HR Tools (hragentify@gmail.com)', ...extraHeaders }
      });
      if (!r.ok) { console.warn(`[TT BG] workDownloadResume ${url} ← ${r.status}`); return null; }
      const _wMime     = (r.headers.get('content-type') || '').split(';')[0].trim() || 'application/pdf';
      const _wMimeExt  = { 'application/pdf':'pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/msword':'doc','application/rtf':'rtf','text/plain':'txt' };
      const _wExt      = _wMimeExt[_wMime] || 'pdf';
      const _wFilename = _getFilenameFromResponse(r, `resume.${_wExt}`);
      const blob       = await r.blob();
      const arrayBuf   = await blob.arrayBuffer();
      if (!arrayBuf.byteLength) return null;
      const uint8Array = new Uint8Array(arrayBuf);
      let binary = '';
      uint8Array.forEach(b => { binary += String.fromCharCode(b); });
      return { base64: btoa(binary), mimeType: _wMime, fileName: _wFilename };
    } catch (e) { console.warn('[TT BG] workDownloadResume fetch error:', e); return null; }
  }

  // ── 1. Основний: response_files/{jobId}/{responseId} (відповідь на вакансію) ──
  if (jobId && responseId) {
    const res = await _fetchToBase64(`https://api.work.ua/response_files/${jobId}/${responseId}`);
    if (res) return res;
  }

  // ── 2. Fallback: /resumes/{id} → file.url (публічні сторінки /resumes/) ──
  // GET /resumes/{id} повертає об'єкт з полем file що містить download URL.
  const _lookupId = resumeId || responseId;
  if (_lookupId) {
    try {
      const resumeData = await workApiGet(`/resumes/${_lookupId}`);
      const rd = resumeData?.data || resumeData;
      const fileUrl = (typeof rd?.file === 'string' ? rd.file : '')
                   || rd?.file?.url || rd?.file?.download_url || rd?.file?.path
                   || rd?.file_url  || rd?.resume_url || '';
      if (fileUrl) {
        console.log('[TT BG] workDownloadResume resume file URL:', fileUrl);
        const res = await _fetchToBase64(fileUrl);
        if (res) return res;
      }
    } catch (_) {}
  }

  return null;
}

async function uploadResumeToTT(base64Data, mimeType, fileName, candidateId) {
  const prefs = await getPrefs();
  const key   = (prefs.tt_api_key || '').trim();
  console.log('[TT BG] uploadResumeToTT → POST /v1/files',
    '| fileName:', fileName,
    '| mimeType:', mimeType,
    '| base64 len:', base64Data?.length || 0,
    '| candidateId:', candidateId || '(none)',
    '| hasKey:', !!key
  );
  try {
    // Конвертуємо base64 назад в blob
    const binary = atob(base64Data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    console.log('[TT BG] uploadResumeToTT blob size:', blob.size, 'bytes');

    const form = new FormData();
    form.append('file', blob, fileName || 'resume.pdf');

    const r = await fetchWithRetry('https://api.teamtailor.com/v1/files', {
      method:  'POST',
      headers: {
        'Authorization':  `Token token=${key}`,
        'X-Api-Version':  TT_API_VERSION
      },
      body: form
    });
    console.log('[TT BG] uploadResumeToTT /v1/files ←', r.status);
    if (!r.ok) {
      const errBody = await r.text().catch(() => '(no body)');
      console.warn('[TT BG] uploadResumeToTT failed:', r.status, errBody.substring(0, 300));
      return null;
    }
    const data = await r.json();
    console.log('[TT BG] uploadResumeToTT /v1/files response:', JSON.stringify(data).substring(0, 400));
    const url = data?.uri || data?.data?.attributes?.url || null;
    console.log('[TT BG] uploadResumeToTT → resultUrl:', url);
    return url;
  } catch (e) {
    console.warn('[TT BG] uploadResumeToTT exception:', e);
    return null;
  }
}
