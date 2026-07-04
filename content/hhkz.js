// ============================================================
// Teamtailor Importera — content/hhkz.js v1.0
// hh.kz employer pages: responses, resume search, individual resume
// ============================================================

const _hhHtmlEsc   = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const _hhSafeUrl   = u => /^https:\/\/app\.teamtailor\.com\//.test(String(u || '')) ? u : '#';
const _hhSafePic   = u => /^https?:\/\//i.test(String(u || '')) ? _hhHtmlEsc(u) : '';

const HH_FIXED_TAGS = [
  'hh.kz',
  'alexandra (recruiter)', 'alexandra (recruiter/sourcer)',
  'anastasiia (recruiter)', 'daniela (recruiter)', 'daryna (recruiter)', 'daryna (sourcer)',
  'julia (sourcer)', 'maria (recruiter)', 'maryna (recruiter/sourcer)', 'oleksandra (sourcer)',
  'ruslana (recruiter)', 'serhii (recruiter)', 'sofia (recruiter)',
  'valentyna (sourcer)', 'victoriia (sourcer)'
];

let hhPrefs      = {};
let hhSelected   = new Set();
let hhCheckCache = new Map(); // resumeId → { status, ttData, info }

// API prefetch: resumeId → { phone, email, firstName, lastName, photo, negotiationId }
const hhApiData  = new Map();

async function hhLoadPrefs() {
  return new Promise(r => chrome.storage.local.get(null, d => { hhPrefs = d || {}; r(); }));
}

function hhBgMsg(msg) {
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
        } else resolve(resp);
      });
    } catch(e) { reject(e); }
  });
}

// ── Phone normalization ──────────────────────────────────────
// hh.kz: +7 (Russian/Kazakhstan), +996 (Kazakhstan), +380 (Ukraine), etc.
function hhNormalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  // +996 Kazakhstan: 12 цифр починається з 996
  if (digits.length === 12 && digits.startsWith('996')) return '+' + digits;
  // +7 RU/KZ: 11 цифр починається з 7 або 8
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8')))
    return '+7' + digits.slice(1);
  // 10 цифр без коду країни → вважаємо +7
  if (digits.length === 10) return '+7' + digits;
  // Інші (380 Ukraine 12 цифр, тощо) — повертаємо з плюсом якщо є цифри
  if (digits.length >= 10) return (raw.trim().startsWith('+') ? '' : '+') + digits;
  return raw.trim();
}

// ── Tooltip helper (clickable link) ─────────────────────────
function _hhSetTooltipDupe(tooltip, emoji, label, url, name) {
  tooltip.textContent = '';
  const prefix = document.createTextNode(`${emoji} ${label}`);
  tooltip.appendChild(prefix);
  if (url && name) {
    tooltip.appendChild(document.createTextNode(' — '));
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.textContent = name;
    a.addEventListener('click',      e => e.stopPropagation());
    a.addEventListener('mousedown',  e => e.stopPropagation());
    tooltip.appendChild(a);
  }
}

// ── Extract candidateId and name from a card element ─────────
function _hhResumeIdFromHref(href) {
  if (!href) return '';
  // /resume/UUID  або  /search/resume?resume=UUID
  return href.match(/\/resume\/([a-f0-9]{20,})/i)?.[1]
      || new URLSearchParams(href.split('?')[1] || '').get('resume')
      || '';
}

function hhExtractFromCard(card) {
  const link = card.querySelector('a[href*="/resume/"], a[href*="resume="]');
  const href = link?.href || '';
  // data-resume-hash на картці пошуку (hh.kz не використовує <a> для переходу)
  const resumeId = _hhResumeIdFromHref(href) || card.dataset?.resumeHash || '';

  // Шукаємо ім'я: спочатку data-qa не-посилання, потім патерн "Ім'я, NN лет"
  let rawName = '';
  const nameEl = card.querySelector([
    '[data-qa="resume-block-title"]',
    '[data-qa="negotiation__applicant-name"]',
    '[data-qa="resume-serp__resume-full-name"]',
    '[data-qa="resume-serp__resume-applicant"]',
    '[data-qa="resume-serp__resume-name"]',
    '[data-qa="resume-applicant-name"]',
    '[data-qa="resume-name"]'
  ].join(', '));
  if (nameEl) {
    rawName = nameEl.textContent.trim();
  }

  // Не використовуємо Cyrillic regex fallback — він підхоплює назви компаній, посади тощо.
  // Ім'я на картках пошуку hh.kz приховане; отримуємо через API при кліку +TT.

  rawName = rawName.replace(/,.*$/, '').replace(/\s*\(.*\)/, '').trim();
  const parts = rawName.split(/\s+/).filter(Boolean).slice(0, 3);
  let lastName = '', firstName = '';
  if (parts.length >= 2) {
    lastName  = parts[0] || '';
    firstName = parts[1] || '';
  } else if (parts[0]) {
    firstName = parts[0];
  }

  // Photo — враховуємо lazy-load (data-src / data-lazy-src / src)
  const imgEl = card.querySelector('img[src*="hhcdn"], img[src*="hh.kz"], img[data-qa="resume-avatar"], img[data-src*="hhcdn"], img[data-src*="hh"], img[src*="http"]');
  const picture = imgEl
    ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || imgEl.getAttribute('data-original') || imgEl.src || '')
    : '';

  const resolvedHref = href || (resumeId ? `https://${location.host}/resume/${resumeId}` : '');
  return { resumeId, firstName, lastName, fullName: rawName, picture, href: resolvedHref };
}

// ── Badge injection ──────────────────────────────────────────
const hhSemaphore = { count: 0, max: 3, queue: [] };
function hhAcquire() {
  return new Promise(resolve => {
    if (hhSemaphore.count < hhSemaphore.max) { hhSemaphore.count++; resolve(); }
    else hhSemaphore.queue.push(resolve);
  });
}
function hhRelease() {
  if (hhSemaphore.queue.length) { hhSemaphore.queue.shift()(); }
  else hhSemaphore.count--;
}

async function hhProcessCard(card) {
  // Не обробляємо елементи всередині нашої модалки
  if (card.closest('.tt-modal-overlay, .tt-panel, [id^="tt-"]')) return;
  const info = hhExtractFromCard(card);
  if (!info.resumeId || card.querySelector('.tt-badge-wrap')) return;

  // Merge API contacts (from prefetch) into info
  const apiEntry = hhApiData.get(info.resumeId);
  if (apiEntry) {
    if (!info.firstName && apiEntry.firstName) info.firstName = apiEntry.firstName;
    if (!info.lastName  && apiEntry.lastName)  info.lastName  = apiEntry.lastName;
    if (!info.picture   && apiEntry.photo)     info.picture   = apiEntry.photo;
    info._apiPhone = apiEntry.phone || '';
    info._apiEmail = apiEntry.email || '';
    info._negotiationId = apiEntry.negotiationId || '';
  }

  // Wrap for badge — абсолютно поверх фото (правий нижній кут)
  // Це не впливає на flex-лейаут картки незалежно від типу сторінки
  const wrap = document.createElement('div');
  wrap.className = 'tt-badge-wrap';
  wrap.dataset.hhId = info.resumeId;
  wrap.style.cssText = 'position:absolute;bottom:0;right:0;z-index:10;display:flex;align-items:center;gap:3px;background:rgba(255,255,255,0.88);border-radius:4px 0 4px 0;padding:1px 3px;';

  const dot = document.createElement('span');
  dot.className = 'tt-dot grey';
  dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';

  const tooltip = document.createElement('span');
  tooltip.className = 'tt-tooltip';
  tooltip.textContent = '⏳ Перевіряю...';
  dot.appendChild(tooltip);
  wrap.appendChild(dot);

  // Знаходимо фото-колонку: img → найближчий photo-контейнер, або прямо по класу колонки
  const imgEl = card.querySelector('img[src*="hhcdn"], img[src*="hh.kz"], img[data-qa="resume-avatar"], img[src*="http"]');
  const photoContainer = imgEl
    ? (imgEl.closest('[class*="photo"], [class*="avatar"], [class*="image"]') || imgEl.parentElement)
    : card.querySelector('[class*="column-photo"], [class*="photo-column"], [class*="photo__"]');

  if (photoContainer) {
    // Бейдж поверх фото (bottom-right)
    if (getComputedStyle(photoContainer).position === 'static') photoContainer.style.position = 'relative';
    wrap.style.cssText = 'position:absolute;bottom:0;right:0;z-index:10;display:flex;align-items:center;gap:3px;background:rgba(255,255,255,0.88);border-radius:4px 0 4px 0;padding:1px 3px;';
    photoContainer.appendChild(wrap);
  } else {
    // Немає фото-контейнера — вставляємо в лівий верхній кут картки (top-left, завжди видно)
    const _anchor = card;
    if (getComputedStyle(_anchor).position === 'static') _anchor.style.position = 'relative';
    wrap.style.cssText = 'position:absolute;top:8px;left:8px;z-index:10;display:flex;align-items:center;gap:3px;background:rgba(255,255,255,0.88);border-radius:4px;padding:1px 3px;';
    _anchor.appendChild(wrap);
  }

  // Contacts: API prefetch (priority) → DOM fallback
  const cardPhoneEl = card.querySelector('a[href^="tel:"]');
  const cardEmailEl = card.querySelector('a[href^="mailto:"]');
  const domPhone    = hhNormalizePhone(cardPhoneEl?.href?.replace('tel:', '') || cardPhoneEl?.textContent?.trim() || '');
  const domEmail    = cardEmailEl?.href?.replace('mailto:', '') || cardEmailEl?.textContent?.trim() || '';
  const badgePhone  = info._apiPhone || domPhone;
  const badgeEmail  = info._apiEmail || domEmail;

  // Show green immediately; async checks update the badge later
  let status = 'green', ttData = null;
  hhCheckCache.set(info.resumeId, { status, ttData, info });
  dot.className = 'tt-dot green';
  dot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;';
  tooltip.textContent = '✅ Немає в Teamtailor';

  // Render the +TT button immediately so user can import without waiting
  const _renderBtn = (st, td) => {
    wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
    if (st === 'red') {
      if (td?.url) {
        const lnk = document.createElement('a');
        lnk.href = td.url; lnk.target = '_blank';
        lnk.className = 'tt-btn';
        lnk.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;text-decoration:none;';
        lnk.textContent = '↗ TT';
        lnk.addEventListener('click', e => e.stopPropagation());
        wrap.appendChild(lnk);
      }
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tt-btn' + (st === 'orange' ? ' update' : '');
      btn.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;';
      btn.textContent = st === 'orange' ? '↺ TT' : '+TT';
      btn.addEventListener('click', async e => {
        e.stopPropagation(); e.preventDefault();
        // Оновлюємо з API prefetch в момент кліку (може прийти після processCard)
        const latestApi = hhApiData.get(info.resumeId);
        if (latestApi) {
          if (!info.firstName && latestApi.firstName) info.firstName = latestApi.firstName;
          if (!info.lastName  && latestApi.lastName)  info.lastName  = latestApi.lastName;
          if (!info.picture   && latestApi.photo)     info.picture   = latestApi.photo;
          if (!info._apiPhone && latestApi.phone)     info._apiPhone = latestApi.phone;
          if (!info._apiEmail && latestApi.email)     info._apiEmail = latestApi.email;
        }
        // Завжди підтягуємо з API якщо немає контактів
        // (картки пошуку не показують ПІБ і контакти; API може їх повернути)
        if (!info._apiPhone && !info._apiEmail) {
          try {
            btn.textContent = '⏳';
            const _r = await Promise.race([
              hhBgMsg({ type: 'HH_GET_RESUME', resumeId: info.resumeId, topicId: null }),
              new Promise(r => setTimeout(r, 4000))
            ]);
            if (_r?.ok && _r.resume) {
              const _res = _r.resume;
              // Завжди перезаписуємо ім'я з API (card parsing може дати хибні дані)
              if (_res.last_name)  info.lastName  = _res.last_name;
              if (_res.first_name) info.firstName = _res.first_name;
              const { phone: _ap, email: _ae } = hhContactFromResume(_res);
              if (_ap) info._apiPhone = _ap;
              if (_ae) info._apiEmail = _ae;
              if (!info.picture && (_res.photo?.medium || _res.photo?.small))
                info.picture = _res.photo.medium || _res.photo.small;
              hhApiData.set(info.resumeId, {
                phone: _ap, email: _ae,
                firstName: _res.first_name || '', lastName: _res.last_name || '',
                photo: _res.photo?.medium || '', negotiationId: null,
              });
            }
          } catch (_) {} finally { btn.textContent = '+TT'; }
        }
        const cached = hhCheckCache.get(info.resumeId);
        const mergedInfo = {
          ...info,
          phone: info._apiPhone || '',
          email: info._apiEmail || '',
          ttData: cached?.ttData || null,
        };
        const knownDupe = (cached?.status === 'red' || cached?.status === 'orange') ? cached?.ttData : null;
        if (knownDupe) {
          hhOpenDupePopup(knownDupe, mergedInfo,
            () => hhOpenImportModal(mergedInfo, cached?.status || 'red'),
            () => {});
        } else {
          hhOpenImportModal(mergedInfo, cached?.status || 'green');
        }
      });
      wrap.appendChild(btn);
    }
  };
  _renderBtn('green', null);

  // Synchronous check (semaphore) only when contacts are available in the card
  if (badgePhone || badgeEmail) {
    await hhAcquire();
    try {
      const resp = await Promise.race([
        hhBgMsg({ type: 'CHECK_DUPLICATE', phone: badgePhone, email: badgeEmail,
                  name: `${info.firstName} ${info.lastName}`.trim() }),
        new Promise(r => setTimeout(() => r(null), 8000))
      ]);
      if (resp?.dupe) {
        ttData = resp.dupe;
        status = 'red';
        const cmpResp = await Promise.race([
          hhBgMsg({ type: 'COMPARE_WITH_TT', ttId: resp.dupe.id,
                    candidate: { phone: badgePhone, email: badgeEmail } }),
          new Promise(r => setTimeout(() => r(null), 6000))
        ]);
        if (cmpResp?.result?.hasDiffs) status = 'orange';
      }
    } catch(e) { status = 'grey'; }
    hhRelease();

    hhCheckCache.set(info.resumeId, { status, ttData, info });
    dot.className = `tt-dot ${status}`;
    if (status === 'green')       tooltip.textContent = '✅ Немає в Teamtailor';
    else if (status === 'red')    _hhSetTooltipDupe(tooltip, '🔴', 'Є в TT', ttData?.url, ttData?.name);
    else if (status === 'orange') _hhSetTooltipDupe(tooltip, '🟠', 'Дані різняться', ttData?.url, ttData?.name);
    _renderBtn(status, ttData);
  }

  // Fire-and-forget name check — two orderings, no semaphore, updates badge async
  if (status === 'green' && info.firstName && info.lastName) {
    const _order1 = `${info.firstName} ${info.lastName}`.trim();
    const _order2 = `${info.lastName} ${info.firstName}`.trim();

    const _applyNameDupe = (_dup) => {
      if (hhCheckCache.get(info.resumeId)?.status === 'red') return;
      hhCheckCache.set(info.resumeId, { status: 'red', ttData: _dup, info });
      dot.className = 'tt-dot red';
      _hhSetTooltipDupe(tooltip, '🔴', 'Є в TT', _dup.url, _dup.name);
      _renderBtn('red', _dup);
    };

    hhBgMsg({ type: 'PANEL_CHECK_DUPLICATE', phone: '', email: '', name: _order1 })
      .then(r => { if (r?.dupe) _applyNameDupe(r.dupe); }).catch(() => {});
    hhBgMsg({ type: 'PANEL_CHECK_DUPLICATE', phone: '', email: '', name: _order2 })
      .then(r => { if (r?.dupe) _applyNameDupe(r.dupe); }).catch(() => {});
  }
}

// ── Scan all cards ───────────────────────────────────────────
function hhScanCards() {
  const selectors = [
    '[data-qa="resume-serp__resume"]',
    '[data-qa="negotiation-list-item"]',
    '[data-qa="negotiations-list__item"]',
    '[data-hh-value="resume"]',
    'li.resume',
    'article[class*="resume"]',
  ];

  const seen = new Set();
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(card => {
      if (seen.has(card) || card.querySelector('.tt-badge-wrap')) return;
      const link = card.querySelector('a[href*="/resume/"], a[href*="resume="]');
      const id = _hhResumeIdFromHref(link?.href || '') || card.dataset?.resumeHash || '';
      if (id) { seen.add(card); hhProcessCard(card); }
    });
  }

  // Завжди запускаємо link-based fallback — він доповнює primary, не замінює
  // Потрібно для сторінки пошуку де data-qa може відрізнятись
  const _cardSeen = new Set([...seen]);
  document.querySelectorAll('a[href*="/resume/"], a[href*="resume="]').forEach(link => {
    const id = _hhResumeIdFromHref(link.href);
    if (!id) return;

    // Знаходимо контейнер картки: спочатку data-qa-батько, потім класи, потім висота
    let card = link.closest('[data-qa]');
    // Якщо знайдений data-qa занадто малий (< 100px) — шукаємо вище
    if (card && card.offsetHeight < 100) {
      card = card.parentElement?.closest('[data-qa]') || null;
    }
    if (!card) {
      card = link.closest('li, article, [class*="item"], [class*="card"]');
    }
    if (!card) {
      // Висотний fallback: знаходимо першого батька > 120px
      let _el = link.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!_el || _el === document.body) break;
        if (_el.offsetHeight > 120) { card = _el; break; }
        _el = _el.parentElement;
      }
    }
    if (!card) return;
    // Уникаємо дублювань: перевіряємо чи картка вже оброблена або є батьком вже обробленої
    if (_cardSeen.has(card) || card.querySelector('.tt-badge-wrap')) return;
    // Перевіряємо що в картці є той самий resumeId (не інший)
    const _cardId = _hhResumeIdFromHref(card.querySelector('a[href*="/resume/"], a[href*="resume="]')?.href || '');
    if (_cardId !== id) return;
    _cardSeen.add(card);
    hhProcessCard(card);
  });

  // Пошук по [data-resume-hash] — hh.kz пошук не використовує <a>, але є data-атрибут
  document.querySelectorAll('[data-resume-hash]').forEach(card => {
    if (_cardSeen.has(card) || card.querySelector('.tt-badge-wrap')) return;
    const id = card.dataset.resumeHash || '';
    if (!id || id.length < 20) return;
    _cardSeen.add(card);
    hhProcessCard(card);
  });
}

// ── Detail page button (/resume/{id} or /employer/resume/{id}) ──
async function hhAddDetailPageButton() {
  if (document.querySelector('.tt-detail-btn')) return;

  const resumeId = _hhResumeIdFromHref(location.href);
  if (!resumeId) return;

  // topic_id дозволяє API повернути контакти (телефон/email) без додаткового кроку відкриття
  const _sp = new URLSearchParams(location.search);
  const _topicId = _sp.get('resumeId') || _sp.get('topicId') || _sp.get('topic_id') || null;

  // Автоматично клікаємо "Показати всі контакти" якщо він є на сторінці
  // hh.kz ховає телефон/email за цим посиланням; клік відкриває їх у DOM
  // hh.kz: "Показати всі контакти" — span (не a/button) у блоці контактів
  const _showAllBtn = document.querySelector([
    '[data-qa="resume-contacts__showAll"]',
    '[data-qa="resume-show-contacts"]',
    'a[href*="showContacts"]',
  ].join(', ')) || (() => {
    // Спочатку шукаємо у блоці контактів, потім по всій сторінці
    const _scope = document.querySelector('[data-qa="resume-contacts"], .resume-contacts, [class*="resume-contacts"]') || document;
    for (const el of _scope.querySelectorAll('span, a, button')) {
      if (el.children.length > 0) continue; // тільки листові вузли
      const t = el.textContent?.trim() || '';
      if (t.length < 60 && /показат|show.?all|всі контакти/i.test(t)) return el;
    }
    return null;
  })();
  if (_showAllBtn) {
    _showAllBtn.click();
    // дамо DOM оновитись перед читанням контактів нижче
    await new Promise(r => setTimeout(r, 600));
  }

  // Extract contacts visible on the page (employer has access after paying for the resume)
  const phoneEl = document.querySelector([
    '[data-qa="resume-contacts-phone"] a[href^="tel:"]',
    '[data-qa="resume-contact-phone-number"]',
    '[data-qa="resume-contacts-phone"] span',
    'a[href^="tel:"]'
  ].join(', '));
  const emailEl = document.querySelector([
    '[data-qa="resume-contact-email"] a[href^="mailto:"]',
    '[data-qa="resume-contacts-email"] a',
    '[data-qa="resume-contacts-email"] span',
    'a[href^="mailto:"]'
  ].join(', '));
  // Ім'я кандидата — НЕ h1 (h1 містить посаду на karaganda.hh.kz)
  // DevTools: ім'я в <span> всередині <h2> в [data-qa="resume-main-info__header"]
  const nameEl = document.querySelector([
    '[data-qa="resume-personal-name"]',
    '[data-qa="resume-block-personal-name"]',
    '[data-qa="resume-main-info__header"] h2',
    '[data-qa="resume-main-info__header"] span',
    'h1[itemprop="name"]',
    'h2[itemprop="name"]',
  ].join(', '));
  const photoEl = document.querySelector('[data-qa="resume-photo"] img, .resume-photo img');

  let rawPhone = phoneEl?.textContent?.trim() || phoneEl?.href?.replace('tel:', '') || '';
  // Fallback: шукаємо будь-який елемент з текстом схожим на телефон (hh.kz: plain text, не tel: link)
  if (!rawPhone) {
    const _phRe = /^[\+\d][\d\s\-\(\)]{6,18}$/;
    for (const el of document.querySelectorAll('span, p, div')) {
      if (el.children.length > 0) continue;
      const _t = (el.textContent || '').trim();
      if (_phRe.test(_t) && _t.replace(/\D/g, '').length >= 10) { rawPhone = _t; break; }
    }
  }
  const rawEmail = emailEl?.textContent?.trim() || emailEl?.href?.replace('mailto:', '') || '';
  let rawName = nameEl?.textContent?.trim().replace(/,.*$/, '').replace(/\s*\(.*\)/, '').trim() || '';
  // Fallback: перший рядок заголовка вкладки (Chrome: "Ім'я Прізвище — hh.kz")
  if (!rawName) {
    const _titlePart = document.title.split(/[—–\|]/)[0].trim();
    if (_titlePart && _titlePart.length > 3 && _titlePart.length < 60) rawName = _titlePart;
  }
  const parts    = rawName.split(/\s+/).filter(Boolean).slice(0, 3);
  const lastName  = parts[0] || '';
  const firstName = parts[1] || '';
  const picture   = photoEl
    ? (photoEl.getAttribute('data-src') || photoEl.getAttribute('data-lazy-src') || photoEl.getAttribute('data-original') || photoEl.src || '')
    : '';

  const info = {
    resumeId, firstName, lastName, fullName: rawName, picture,
    phone: hhNormalizePhone(rawPhone), email: rawEmail,
    href: location.href
  };

  // Запускаємо API-запит паралельно — він поповнить info до кліку кнопки
  // GET /resumes/{id}?topic_id={negotiation_id} повертає контакти коли є topic_id
  let _apiPromise = null;
  if (_topicId || !info.phone) {
    _apiPromise = hhBgMsg({ type: 'HH_GET_RESUME', resumeId, topicId: _topicId })
      .then(resp => {
        if (!resp?.ok || !resp.resume) return;
        const r = resp.resume;
        const { phone: _aph, email: _aem } = hhContactFromResume(r);
        if (_aph) info.phone = _aph;
        if (_aem) info.email = _aem;
        // API може повертати last_name/first_name або порожніми (hh.kz приховує для деяких)
        if (r.last_name)  { info.lastName  = r.last_name; }
        if (r.first_name) { info.firstName = r.first_name; }
        // Якщо API не дало ім'я — парсимо з поля "title" (ПІБ зазвичай є там)
        if (!info.firstName && !info.lastName && r.title) {
          const _ps = String(r.title).trim().split(/\s+/).filter(Boolean);
          if (_ps.length >= 2) { info.lastName = _ps[0]; info.firstName = _ps[1]; }
          else if (_ps.length === 1) { info.firstName = _ps[0]; }
        }
        if (!info.fullName) {
          if (info.firstName || info.lastName)
            info.fullName = `${info.firstName} ${info.lastName}`.trim();
        }
        if (!info.picture && (r.photo?.medium || r.photo?.small)) info.picture = r.photo.medium || r.photo.small;
        hhApiData.set(resumeId, {
          phone: _aph, email: _aem,
          firstName: r.first_name || '', lastName: r.last_name || '',
          photo: r.photo?.medium || '', negotiationId: _topicId,
        });
        console.log('[TT hhkz] API дані:', info.firstName, info.lastName, 'тел:', info.phone, 'email:', info.email);
      })
      .catch(e => console.warn('[TT hhkz] HH_GET_RESUME помилка:', e.message));
  }

  // Dot-светофор для детальної сторінки
  const detailDot = document.createElement('span');
  detailDot.className = 'tt-dot loading';
  detailDot.style.cssText = 'width:10px;height:10px;flex-shrink:0;position:relative;display:inline-block;vertical-align:middle;margin-right:4px;';
  const detailTooltip = document.createElement('span');
  detailTooltip.className = 'tt-tooltip';
  detailTooltip.textContent = '⏳ Перевіряю...';
  detailDot.appendChild(detailTooltip);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tt-btn tt-detail-btn';
  btn.style.cssText = 'margin:0 8px;font-size:11px;padding:4px 12px;display:inline-block;vertical-align:middle;';
  btn.textContent = '+ Додати в Teamtailor';

  btn.addEventListener('click', async () => {
    // Якщо API-запит ще виконується — чекаємо його (максимум 3 сек)
    if (_apiPromise) {
      try { await Promise.race([_apiPromise, new Promise(r => setTimeout(r, 3000))]); } catch (_) {}
      _apiPromise = null;
    }
    // Re-read contacts якщо їх не було при ініціалізації кнопки
    if (!info.phone) {
      const _phEl = document.querySelector(
        '[data-qa="resume-contacts-phone"] a[href^="tel:"], [data-qa="resume-contact-phone-number"], [data-qa="resume-contacts-phone"] span, a[href^="tel:"]'
      );
      if (_phEl) {
        info.phone = hhNormalizePhone(_phEl.textContent?.trim() || _phEl.href?.replace('tel:', '') || '');
      }
      if (!info.phone) {
        const _phRe = /^[\+\d][\d\s\-\(\)]{6,18}$/;
        for (const el of document.querySelectorAll('span, p, div')) {
          if (el.children.length > 0) continue;
          const _t = (el.textContent || '').trim();
          if (_phRe.test(_t) && _t.replace(/\D/g, '').length >= 10) { info.phone = hhNormalizePhone(_t); break; }
        }
      }
    }
    if (!info.email) {
      const em = document.querySelector('[data-qa="resume-contact-email"] a, [data-qa="resume-contacts-email"] span, a[href^="mailto:"]');
      if (em) info.email = em.textContent?.trim() || em.href?.replace('mailto:', '') || '';
    }
    if (!info.firstName && !info.lastName) {
      const _nEl = document.querySelector('[data-qa="resume-personal-name"], [data-qa="resume-block-personal-name"], h1[itemprop="name"], h1');
      if (_nEl) {
        const _rawN = _nEl.textContent?.trim().replace(/,.*$/, '').replace(/\s*\(.*\)/, '').trim() || '';
        const _ps = _rawN.split(/\s+/).filter(Boolean);
        info.lastName  = _ps[0] || '';
        info.firstName = _ps[1] || '';
        if (!info.fullName) info.fullName = _rawN;
      }
    }

    const cached = hhCheckCache.get(resumeId);
    const mergedInfo = { ...info, ttData: cached?.ttData || null };
    const knownDupe = (cached?.status === 'red' || cached?.status === 'orange') ? cached?.ttData : null;

    if (!knownDupe && (info.phone || info.email)) {
      try {
        const dr = await hhBgMsg({ type: 'CHECK_DUPLICATE',
          phone: info.phone, email: info.email,
          name: `${info.firstName} ${info.lastName}`.trim() });
        if (dr?.dupe) {
          hhOpenDupePopup(dr.dupe, mergedInfo,
            () => hhOpenImportModal(mergedInfo, 'green'),
            () => {});
          return;
        }
      } catch(_) {}
    }

    if (knownDupe) {
      hhOpenDupePopup(knownDupe, mergedInfo,
        () => hhOpenImportModal(mergedInfo, cached?.status || 'red'),
        () => {});
    } else {
      hhOpenImportModal(mergedInfo, cached?.status || 'green');
    }
  });

  // Insert dot + button near page heading
  const _wrap = document.createElement('span');
  _wrap.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;';
  _wrap.appendChild(detailDot);
  _wrap.appendChild(btn);

  let anchor = document.querySelector('[data-qa="resume-personal-name"], h1');
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(_wrap, anchor.nextSibling);
  } else {
    const main = document.querySelector('main, [role="main"], .resume');
    if (main) main.prepend(_wrap);
    else document.body.appendChild(_wrap);
  }

  // Асинхронна перевірка дубля — оновлює dot після отримання API даних
  ;(async () => {
    try {
      if (_apiPromise) await Promise.race([_apiPromise, new Promise(r => setTimeout(r, 4000))]);
    } catch (_) {}
    const _ph = info.phone || info._apiPhone || '';
    const _em = info.email || info._apiEmail || '';
    if (!_ph && !_em) {
      detailDot.className = 'tt-dot grey';
      detailTooltip.textContent = '❓ Немає контактів для перевірки';
      return;
    }
    try {
      const _dr = await hhBgMsg({ type: 'CHECK_DUPLICATE',
        phone: _ph, email: _em,
        name: `${info.firstName} ${info.lastName}`.trim() });
      if (_dr?.dupe) {
        hhCheckCache.set(resumeId, { status: 'red', ttData: _dr.dupe, info });
        detailDot.className = 'tt-dot red';
        _hhSetTooltipDupe(detailTooltip, '🔴', 'Є в TT', _dr.dupe.url, _dr.dupe.name);
        btn.textContent = '↺ Оновити / Переглянути';
      } else {
        hhCheckCache.set(resumeId, { status: 'green', ttData: null, info });
        detailDot.className = 'tt-dot green';
        detailTooltip.textContent = '✅ Немає в Teamtailor';
      }
    } catch (_) {
      detailDot.className = 'tt-dot grey';
      detailTooltip.textContent = '❓ Не вдалось перевірити';
    }
  })();
}

// ── Dupe popup ───────────────────────────────────────────────
function hhOpenDupePopup(ttData, info, onAddAnyway, onUpdate) {
  const overlay = document.createElement('div');
  overlay.className = 'tt-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'tt-modal';
  modal.style.maxWidth = '420px';
  const ttUrl  = ttData?.url  || '';
  const ttName = ttData?.name || `${info.firstName||''} ${info.lastName||''}`.trim();
  const candName = `${info.firstName||''} ${info.lastName||''}`.trim();
  modal.innerHTML =
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;">' +
      '<h2 style="color:#e17055;margin:0;">⚠️ Кандидат вже є в Teamtailor</h2>' +
      '<button id="tt-dp-x" style="background:none;border:none;cursor:pointer;font-size:20px;color:#b2bec3;line-height:1;padding:0 2px;">✕</button>' +
    '</div>' +
    '<p style="font-size:13px;color:#555;margin:0 0 12px;"><strong>' + _hhHtmlEsc(candName) + '</strong> збігається з кандидатом у базі.</p>' +
    '<div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:10px 14px;margin-bottom:16px;">' +
      '<div style="font-weight:600;font-size:13px;">' + _hhHtmlEsc(ttName) + '</div>' +
      (ttUrl ? '<a href="' + _hhSafeUrl(ttUrl) + '" target="_blank" style="color:#0984e3;font-size:12px;text-decoration:none;">Відкрити профіль в Teamtailor ↗</a>' : '') +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="tt-dp-update" class="tt-btn" style="background:#6c5ce7;justify-content:center;width:100%;">♻️ Оновити наявний профіль</button>' +
      '<button id="tt-dp-add"    class="tt-btn" style="justify-content:center;width:100%;">➕ Все одно додати</button>' +
      '<button id="tt-dp-cancel" class="tt-btn-cancel" style="text-align:center;width:100%;">Скасувати</button>' +
    '</div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#tt-dp-x').addEventListener('click',      () => overlay.remove());
  modal.querySelector('#tt-dp-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#tt-dp-add').addEventListener('click',    () => { overlay.remove(); onAddAnyway(); });
  modal.querySelector('#tt-dp-update').addEventListener('click', async () => {
    overlay.remove();
    const ur = await hhBgMsg({ type: 'IMPORT_CANDIDATE', candidate: {
      firstName: info.firstName, lastName: info.lastName,
      phone: info.phone||'', email: info.email||'',
      picture: info.picture||'', tags: ['hh.kz', ...(hhPrefs.recruiter_tag ? [hhPrefs.recruiter_tag] : [])],
      source: 'hh.kz', sourceUrl: info.href || location.href,
      ttCandidateId: ttData?.id
    }});
    if (ur?.ok) onUpdate(ur.result);
  });
}

// ── Import modal ─────────────────────────────────────────────
function hhOpenImportModal(info, status) {
  const overlay = document.createElement('div');
  overlay.className = 'tt-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'tt-modal';

  const initTags = ['hh.kz', ...(hhPrefs.recruiter_tag ? [hhPrefs.recruiter_tag] : [])];
  const selectedTags = new Set(initTags);
  let allAvailableTags = [...HH_FIXED_TAGS];

  const displayName = `${info.firstName||''} ${info.lastName||''}`.trim() || info.fullName || '';
  const _eFn   = _hhHtmlEsc(info.firstName  || '');
  const _eLn   = _hhHtmlEsc(info.lastName   || '');
  const _ePh   = _hhHtmlEsc(info.phone      || '');
  const _eEm   = _hhHtmlEsc(info.email      || '');
  const _eName = _hhHtmlEsc(displayName);
  const _eCid  = _hhHtmlEsc(String(info.resumeId || ''));
  const _ePic  = _hhSafePic(info.picture);

  const dupeHtml = (status === 'red' || status === 'orange') && info.ttData?.url
    ? `<div style="background:${status==='red'?'#ffe3e0':'#fff8e1'};border:1.5px solid ${status==='red'?'#e74c3c':'#f39c12'};border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:${status==='red'?'#c0392b':'#e67e22'};">
        ${status==='red'?'🔴 Вже є в Teamtailor':'🟠 Є в TT, дані різняться'} — <a href="${_hhSafeUrl(info.ttData.url)}" target="_blank" style="font-weight:700;color:inherit;">відкрити профіль ↗</a>
       </div>`
    : '';

  modal.innerHTML = `
    <h2>🚀 Імпорт в Teamtailor</h2>
    ${dupeHtml}
    <div class="tt-candidate-preview">
      ${_ePic
        ? `<img src="${_ePic}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`
        : `<div class="tt-avatar-placeholder">${_hhHtmlEsc((info.firstName?.[0] || info.lastName?.[0] || '?').toUpperCase())}</div>`}
      <div class="tt-preview-info">
        <div class="tt-preview-name">${_eName}</div>
        <div class="tt-preview-meta">hh.kz · ID ${_eCid}</div>
      </div>
    </div>
    <div class="tt-field"><label>Ім'я</label><input id="tt-fn" value="${_eFn}"></div>
    <div class="tt-field"><label>Прізвище</label><input id="tt-ln" value="${_eLn}"></div>
    <div class="tt-field"><label>Телефон</label><input id="tt-phone" value="${_ePh}" placeholder="+7..."></div>
    <div class="tt-field"><label>Email</label><input id="tt-email" value="${_eEm}" placeholder="email@..."></div>
    <div class="tt-field" id="tt-resume-btns">
      ${info.href ? `<a href="${_hhSafePic(info.href)}" target="_blank" class="tt-resume-link">📄 Профіль на hh.kz</a>` : ''}
    </div>
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

  // ── Tags UI ──
  const tagsWrap = modal.querySelector('#tt-tags');
  const _renderTagsUI = () => {
    tagsWrap.innerHTML = '';
    const chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;';
    selectedTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tt-tag selected';
      chip.textContent = tag;
      chip.dataset.tag = tag;
      chip.addEventListener('click', () => { selectedTags.delete(tag); _renderTagsUI(); });
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
    const _fillDropdown = () => {
      dropdown.innerHTML = '';
      allAvailableTags.forEach(tag => {
        const item = document.createElement('div');
        item.textContent = tag;
        const isSel = selectedTags.has(tag);
        item.style.cssText = `padding:6px 10px;font-size:12px;cursor:pointer;border-radius:5px;background:${isSel?'#e84b3c':''};color:${isSel?'#fff':'#2d3436'};`;
        item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = '#f0f2f5'; });
        item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
        item.addEventListener('click', e => {
          e.stopPropagation();
          isSel ? selectedTags.delete(tag) : selectedTags.add(tag);
          dropdown.style.display = 'none';
          _renderTagsUI();
        });
        dropdown.appendChild(item);
      });
    };
    btn.addEventListener('click', e => {
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

  // Load extra tags from GraphQL
  hhBgMsg({ type: 'GET_TT_TAGS' }).then(resp => {
    if (!resp?.tags?.length) return;
    const fixedSet = new Set(allAvailableTags.map(t => t.toLowerCase()));
    const skipTags = new Set(['robota.ua', 'work.ua']);
    for (const tag of resp.tags) {
      if (!skipTags.has(tag.toLowerCase()) && !fixedSet.has(tag.toLowerCase()))
        allAvailableTags.push(tag);
    }
  }).catch(() => {});

  // Populate TT dropdowns from cache
  hhBgMsg({ type: 'GET_TT_LISTS' }).then(resp => {
    if (!resp?.ok) return;
    const fill = (selId, items, attrKey, defId) => {
      const sel = modal.querySelector(`#${selId}`);
      if (!sel) return;
      (items || []).forEach(i => {
        const o = new Option(i.attributes?.[attrKey] || i.attributes?.name || i.name || 'Без назви', i.id);
        if (String(i.id) === String(defId)) o.selected = true;
        sel.appendChild(o);
      });
    };
    fill('tt-job',  resp.jobs,  'internal-name', hhPrefs.default_job_id);
    fill('tt-loc',  resp.locs,  'name',          hhPrefs.default_loc_id);
    fill('tt-dept', resp.depts, 'name',          hhPrefs.default_dept_id);
    fill('tt-role', resp.roles, 'name',          hhPrefs.default_role_id);
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
      picture:    info.picture || '',
      jobId:      modal.querySelector('#tt-job').value,
      locationId: modal.querySelector('#tt-loc').value,
      deptId:     modal.querySelector('#tt-dept').value,
      roleId:     modal.querySelector('#tt-role').value,
      comment:    modal.querySelector('#tt-comment').value.trim(),
      tags:       [...selectedTags],
      source:     'hh.kz',
      sourceUrl:  info.href || location.href,
      candidateId: info.resumeId || '',
    };

    const resp = await hhBgMsg({ type: 'IMPORT_CANDIDATE', candidate: c });
    if (resp?.ok) {
      confirmBtn.textContent = '✅ Додано!';
      confirmBtn.className   = 'tt-btn success';

      if (info.resumeId && resp.result?.url) {
        const ttW = {
          id:   String(resp.result?.candidateId || resp.result?.url?.split('/').pop() || ''),
          name: `${c.firstName||''} ${c.lastName||''}`.trim(),
          url:  resp.result.url
        };
        hhCheckCache.set(info.resumeId, { status: 'red', ttData: ttW, info });
        // Update badge on the list card if visible
        const dot = document.querySelector(`.tt-badge-wrap .tt-dot`);
        if (dot) {
          dot.className = 'tt-dot red';
          const tt = dot.querySelector('.tt-tooltip');
          if (tt) _hhSetTooltipDupe(tt, '🔴', 'Є в TT', ttW.url, ttW.name);
        }
      }

      // Show toast
      const toastName = `${c.firstName||''} ${c.lastName||''}`.trim() || info.fullName || '';
      if (resp.result?.url) {
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1a1a2e;color:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5);z-index:2147483647;padding:14px 18px;font-family:system-ui,sans-serif;font-size:13px;';
        toast.innerHTML = `✅ Імпортовано: <a href="${_hhSafeUrl(resp.result.url)}" target="_blank" style="color:#74b9ff;">${_hhHtmlEsc(toastName)}</a> <button style="background:none;border:none;color:#aaa;cursor:pointer;margin-left:8px;font-size:16px;">✕</button>`;
        toast.querySelector('button').addEventListener('click', () => toast.remove());
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
      setTimeout(() => overlay.remove(), 1500);
    } else {
      confirmBtn.textContent = '❌ ' + (resp?.error || 'Помилка').substring(0, 60);
      confirmBtn.className   = 'tt-btn';
      confirmBtn.disabled    = false;
    }
  });
}

// ── hh.kz API prefetch ───────────────────────────────────────
// Витягує vacancy_id з URL, потім через background завантажує всі відгуки
// і кешує контакти в hhApiData. Потім hhProcessCard бачить їх одразу.
function hhExtractVacancyId() {
  // /employer/vacancyresponses?vacancyId=12345
  // /employer/vacancy/12345/responses  or  /negotiations?vacancy_id=12345
  const sp = new URLSearchParams(location.search);
  if (sp.get('vacancyId'))    return sp.get('vacancyId');
  if (sp.get('vacancy_id'))   return sp.get('vacancy_id');
  const m = location.pathname.match(/\/vacancy\/(\d+)\//);
  return m ? m[1] : null;
}

function hhContactFromResume(resume) {
  // hh API: contact[] → {type:{id:'cell'|'home'|'work'|'email'}, value:'...'}
  // Старий формат (деякі ендпоінти): {kind:'phone'|'email', contact_value:'...'}
  let phone = '', email = '';
  for (const c of resume.contact || []) {
    const val = c.value || c.contact_value || '';
    if (!val) continue;
    const typeId = c.type?.id || c.kind || '';
    const isPhone = ['cell', 'home', 'work', 'mobile', 'phone'].includes(typeId);
    const isEmail = typeId === 'email';
    if (!phone && isPhone) phone = hhNormalizePhone(val);
    if (!email && isEmail) email = val;
  }
  return { phone, email };
}

async function hhPrefetchNegotiations(vacancyId) {
  try {
    const resp = await hhBgMsg({ type: 'HH_GET_NEGOTIATIONS', vacancyId });
    if (!resp?.ok || !resp.items?.length) return;

    for (const item of resp.items) {
      const r = item.resume;
      if (!r?.id) continue;
      const { phone, email } = hhContactFromResume(r);
      hhApiData.set(r.id, {
        phone,
        email,
        firstName:      r.first_name  || '',
        lastName:       r.last_name   || '',
        photo:          r.photo?.medium || r.photo?.small || '',
        negotiationId:  item.id,
        canViewFull:    r.can_view_full_info === true,
        resumeUrl:      r.url || '',
      });
    }
    console.log('[TT hhkz] prefetch:', hhApiData.size, 'відгуків для вакансії', vacancyId);

    // Якщо картки вже відрендерились — оновити їхні бейджи
    document.querySelectorAll('.tt-badge-wrap[data-hh-id]').forEach(wrap => {
      const rId = wrap.dataset.hhId;
      if (hhApiData.has(rId)) hhRefreshBadgeFromApi(rId, wrap);
    });
  } catch (e) {
    console.warn('[TT hhkz] prefetch error:', e.message);
  }
}

// Якщо API дані з'явились пізніше ніж бейдж — оновити бейдж
function hhRefreshBadgeFromApi(resumeId, wrap) {
  const api = hhApiData.get(resumeId);
  if (!api?.phone && !api?.email) return;
  const cached = hhCheckCache.get(resumeId);
  if (cached?.status === 'red' || cached?.status === 'orange') return;
  // Запускаємо повторну перевірку з контактами
  hhBgMsg({ type: 'CHECK_DUPLICATE', phone: api.phone, email: api.email,
             name: `${api.firstName} ${api.lastName}`.trim() })
    .then(resp => {
      if (!resp?.dupe) return;
      const dot     = wrap.querySelector('.tt-dot');
      const tooltip = wrap.querySelector('.tt-tooltip');
      if (!dot) return;
      const ttData = resp.dupe;
      hhCheckCache.set(resumeId, { status: 'red', ttData, info: hhCheckCache.get(resumeId)?.info });
      dot.className = 'tt-dot red';
      if (tooltip) _hhSetTooltipDupe(tooltip, '🔴', 'Є в TT', ttData.url, ttData.name);
      wrap.querySelectorAll('.tt-btn').forEach(b => b.remove());
      if (ttData.url) {
        const lnk = document.createElement('a');
        lnk.href = ttData.url; lnk.target = '_blank';
        lnk.className = 'tt-btn';
        lnk.style.cssText = 'font-size:9px;padding:2px 6px;line-height:1.3;white-space:nowrap;text-decoration:none;';
        lnk.textContent = '↗ TT';
        lnk.addEventListener('click', e => e.stopPropagation());
        wrap.appendChild(lnk);
      }
    }).catch(() => {});
}

// ── MutationObserver for SPA navigation ─────────────────────
function hhWatchPage() {
  let scanTimer  = null;
  let lastVacId  = hhExtractVacancyId();

  const schedScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      // При зміні вакансії — очищаємо старі API дані і prefetch нові
      const newVacId = hhExtractVacancyId();
      if (newVacId && newVacId !== lastVacId) {
        lastVacId = newVacId;
        hhApiData.clear();
        hhPrefetchNegotiations(newVacId).catch(() => {});
      }
      hhScanCards();
      if (_hhResumeIdFromHref(location.href)) {
        hhAddDetailPageButton().catch(() => {});
      }
    }, 600);
  };

  new MutationObserver(schedScan).observe(document.body, { childList: true, subtree: true });
}

// ── Init ─────────────────────────────────────────────────────
(async () => {
  await hhLoadPrefs();

  // Prefetch API data for vacancy pages (відгуки/запрошення)
  const vacancyId = hhExtractVacancyId();
  if (vacancyId) {
    // Запускаємо паралельно зі скануванням — не блокуємо відображення бейджів
    hhPrefetchNegotiations(vacancyId).catch(() => {});
  }

  hhScanCards();
  if (_hhResumeIdFromHref(location.href)) {
    setTimeout(() => hhAddDetailPageButton().catch(() => {}), 1000);
  }
  hhWatchPage();
})();
