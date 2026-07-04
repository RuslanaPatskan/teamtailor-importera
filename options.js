// ── options.js v3.4 ────────────────────────────────────────

const RECRUITER_TAGS = [
  'alexandra (recruiter)', 'alexandra (recruiter/sourcer)',
  'anastasiia (recruiter)', 'daniela (recruiter)', 'daryna (recruiter)', 'daryna (sourcer)',
  'julia (sourcer)', 'maria (recruiter)', 'maryna (recruiter/sourcer)', 'oleksandra (sourcer)',
  'ruslana (recruiter)', 'serhii (recruiter)', 'sofia (recruiter)',
  'valentyna (sourcer)', 'victoriia (sourcer)'
];

const TT_BASE        = 'https://api.teamtailor.com/v1';
const TT_API_VERSION = '20240904';

let currentTag = '';

function ttHeaders(key) {
  return {
    'Authorization': `Token token=${key}`,
    'Content-Type':  'application/vnd.api+json',
    'Accept':        'application/vnd.api+json',
    'X-Api-Version': TT_API_VERSION
  };
}

function showStatus(el, type, text) {
  el.style.display = 'flex';
  el.className = `status-bar ${type}`;
  el.textContent = text;
}

// ── Теги: список + ручне поле ──────────────────────────────
function renderTags(selected) {
  const grid = document.getElementById('tags-grid');
  grid.innerHTML = '';
  RECRUITER_TAGS.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-btn' + (tag === selected ? ' active' : '');
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      currentTag = tag;
      document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tag-custom-input').value = '';
    });
    grid.appendChild(btn);
  });
}

// Ручне поле — скидає вибір із списку
document.getElementById('tag-custom-input').addEventListener('input', (e) => {
  currentTag = e.target.value.trim();
  document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
});

// Динамічне завантаження тегів через GraphQL (якщо залогінений у TT)
// Fallback: хардкод RECRUITER_TAGS залишається
function loadTagsFromGql() {
  chrome.runtime.sendMessage({ type: 'GET_TT_TAGS' }, resp => {
    if (resp?.ok && resp.tags?.length && resp.tags.length > RECRUITER_TAGS.length) {
      // GraphQL повернув більше тегів — оновлюємо список
      RECRUITER_TAGS.length = 0;
      resp.tags.forEach(t => RECRUITER_TAGS.push(t));
      renderTags(currentTag);
      if (currentTag && !RECRUITER_TAGS.includes(currentTag)) {
        document.getElementById('tag-custom-input').value = currentTag;
      }
    }
  });
}

async function loadTTLists(key, showKeyStatus = false) {
  const listStatus = document.getElementById('lists-status');
  const keyStatus  = document.getElementById('tt-status');
  if (showKeyStatus) showStatus(keyStatus, 'loading', '⏳ Перевіряю...');
  try {
    const [jobsR, locsR, deptsR, rolesR] = await Promise.all([
      fetch(`${TT_BASE}/jobs?page[size]=30`,        { headers: ttHeaders(key) }),
      fetch(`${TT_BASE}/locations?page[size]=30`,   { headers: ttHeaders(key) }),
      fetch(`${TT_BASE}/departments?page[size]=30`, { headers: ttHeaders(key) }),
      fetch(`${TT_BASE}/roles?page[size]=30`,       { headers: ttHeaders(key) })
    ]);
    // Перевіряємо ключ за першим запитом
    if (showKeyStatus) {
      if (jobsR.status === 401 || jobsR.status === 403) {
        showStatus(keyStatus, 'error', `❌ Ключ недійсний (${jobsR.status})`); return;
      } else if (jobsR.status === 429) {
        showStatus(keyStatus, 'error', '⏱️ Забагато запитів — зачекайте хвилину і спробуйте знову'); return;
      } else if (!jobsR.ok) {
        showStatus(keyStatus, 'error', `❌ Помилка ${jobsR.status}`); return;
      }
      showStatus(keyStatus, 'ok', '✅ Ключ дійсний!');
      setTimeout(() => keyStatus.style.display = 'none', 3000);
    }
    const [jobs, locs, depts, roles] = await Promise.all([
      jobsR.ok  ? jobsR.json()  : { data: [] },
      locsR.ok  ? locsR.json()  : { data: [] },
      deptsR.ok ? deptsR.json() : { data: [] },
      rolesR.ok ? rolesR.json() : { data: [] }
    ]);
    const prefs = await new Promise(r => chrome.storage.local.get(null, r));
    const fill = (selId, items, attrKey, defId) => {
      const sel = document.getElementById(selId);
      sel.innerHTML = '<option value="">— не вибрано —</option>';
      (items.data || []).forEach(i => {
        const o = new Option(i.attributes?.[attrKey] || i.attributes?.name || 'Без назви', i.id);
        if (String(i.id) === String(defId)) o.selected = true;
        sel.appendChild(o);
      });
    };
    fill('default_job_id',  jobs,  'internal-name', prefs.default_job_id);
    fill('default_loc_id',  locs,  'name',          prefs.default_loc_id);
    fill('default_dept_id', depts, 'name',          prefs.default_dept_id);
    fill('default_role_id', roles, 'name',          prefs.default_role_id);
  } catch (e) {
    if (showKeyStatus) showStatus(keyStatus, 'error', '❌ Помилка мережі');
    else showStatus(listStatus, 'error', '❌ Помилка завантаження списків');
  }
}

document.getElementById('btn-test-tt').addEventListener('click', () => {
  const key = document.getElementById('tt_api_key').value.trim();
  if (!key) { showStatus(document.getElementById('tt-status'), 'error', '❌ Введіть API ключ'); return; }
  loadTTLists(key, true);
});


// ── Robota.ua — тест авторизації ───────────────────────────
document.getElementById('btn-test-robota').addEventListener('click', async () => {
  const login    = document.getElementById('robota_login').value.trim();
  const password = document.getElementById('robota_password').value.trim();
  const status   = document.getElementById('robota-status');
  if (!login || !password) { showStatus(status, 'error', '❌ Введіть логін і пароль'); return; }
  showStatus(status, 'loading', '⏳ Перевіряю...');
  try {
    const r = await fetch('https://auth-api.robota.ua/Login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: login, password, remember: true })
    });
    if (r.ok) {
      const text   = await r.text();
      const parsed = (() => { try { return JSON.parse(text.trim()); } catch { return null; } })();
      const token  = typeof parsed === 'string' ? parsed
                   : (parsed?.token || parsed?.access_token || '');
      if (token) {
        // Зберігаємо токен одразу щоб background міг його використати
        chrome.storage.local.set({ robota_token: token, robota_token_time: Date.now() });
        showStatus(status, 'ok', '✅ Авторизація успішна! Токен збережено.');
        setTimeout(() => status.style.display = 'none', 3000);
      } else {
        showStatus(status, 'error', '❌ Сервер не повернув токен — перевірте дані');
      }
    } else if (r.status === 401 || r.status === 400) {
      showStatus(status, 'error', '❌ Невірний логін або пароль');
    } else {
      showStatus(status, 'error', `❌ Помилка ${r.status}`);
    }
  } catch (e) {
    showStatus(status, 'error', '❌ Помилка мережі');
  }
});

const DEFAULT_BACKEND_URL = 'https://tt-importera-cache.packan3.workers.dev';

// ── Backend — тест з'єднання ──────────────────────────────
document.getElementById('btn-test-backend').addEventListener('click', async () => {
  const inputUrl = document.getElementById('backend_url').value.trim();
  const url    = inputUrl || DEFAULT_BACKEND_URL; // якщо порожньо — дефолтний
  const secret = document.getElementById('backend_secret').value.trim();
  const status = document.getElementById('backend-status');
  showStatus(status, 'loading', '⏳ Перевіряю...');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['x-secret'] = secret;
    // Тест batch-check з порожнім масивом
    const r = await fetch(`${url.replace(/\/$/, '')}/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['__test__'] })
    });
    if (r.ok) {
      showStatus(status, 'ok', '✅ Backend доступний! Batch-кеш активовано.');
    } else if (r.status === 401) {
      showStatus(status, 'error', '❌ Невірний секретний ключ (401)');
    } else {
      showStatus(status, 'error', `❌ Помилка ${r.status}`);
    }
  } catch (e) {
    showStatus(status, 'error', '❌ Не вдалось підключитись — перевірте URL');
  }
});

document.getElementById('btn-save').addEventListener('click', () => {
  const data = {
    tt_api_key:      document.getElementById('tt_api_key').value.trim(),
    recruiter_tag:   currentTag,
    default_job_id:  document.getElementById('default_job_id').value,
    default_loc_id:  document.getElementById('default_loc_id').value,
    default_dept_id: document.getElementById('default_dept_id').value,
    default_role_id: document.getElementById('default_role_id').value,
    robota_cf_name:  document.getElementById('robota_cf_name').value.trim() || 'robota_ua',
    work_cf_name:    document.getElementById('work_cf_name').value.trim()   || 'work_ua',
    robota_login:    document.getElementById('robota_login').value.trim(),
    robota_password: document.getElementById('robota_password').value.trim(),
    backend_url:     document.getElementById('backend_url').value.trim(),
    backend_secret:  document.getElementById('backend_secret').value.trim()
  };
  chrome.storage.local.set(data, () => {
    const status = document.getElementById('save-status');
    showStatus(status, 'ok', '✅ Налаштування збережено!');
    setTimeout(() => status.style.display = 'none', 2500);
  });
});

chrome.storage.local.get(null, prefs => {
  if (prefs.tt_api_key) {
    document.getElementById('tt_api_key').value = prefs.tt_api_key;
    loadTTLists(prefs.tt_api_key);
  }
  currentTag = prefs.recruiter_tag || '';
  renderTags(currentTag);
  // Спробувати оновити теги через GraphQL (якщо залогінений у app.teamtailor.com)
  loadTagsFromGql();

  // Якщо збережений тег не зі списку — показуємо у ручному полі
  if (currentTag && !RECRUITER_TAGS.includes(currentTag)) {
    document.getElementById('tag-custom-input').value = currentTag;
  }
  if (prefs.robota_cf_name)  document.getElementById('robota_cf_name').value  = prefs.robota_cf_name;
  if (prefs.work_cf_name)    document.getElementById('work_cf_name').value    = prefs.work_cf_name;
  if (prefs.robota_login)    document.getElementById('robota_login').value    = prefs.robota_login;
  if (prefs.robota_password) document.getElementById('robota_password').value = prefs.robota_password;
  // Якщо backend_url не збережено — показуємо placeholder з дефолтним URL
  document.getElementById('backend_url').value       = prefs.backend_url     || '';
  document.getElementById('backend_url').placeholder = DEFAULT_BACKEND_URL;
  if (prefs.backend_secret)  document.getElementById('backend_secret').value  = prefs.backend_secret;
});
