// ── popup.js ───────────────────────────────────────────────

const TT_BASE        = 'https://api.teamtailor.com/v1';
const TT_API_VERSION = '20240904';

function showStatus(type, text) {
  const el = document.getElementById('status-bar');
  el.className = `status-row ${type}`;
  el.textContent = text;
}

function ttFetch(endpoint, key) {
  return fetch(`${TT_BASE}${endpoint}`, {
    headers: {
      'Authorization': `Token token=${key}`,
      'Accept':        'application/vnd.api+json',
      'X-Api-Version': TT_API_VERSION
    }
  });
}

chrome.storage.local.get(null, async prefs => {
  const key = (prefs.tt_api_key || '').trim();

  document.getElementById('info-tag').textContent = prefs.recruiter_tag || '— не вибрано';

  if (!key) {
    showStatus('error', '❌ API ключ не налаштовано');
    return;
  }

  // Test connection
  try {
    const r = await ttFetch('/candidates?page[size]=1', key);
    if (r.ok) {
      showStatus('ok', '✅ Підключено до Teamtailor');
    } else {
      showStatus('error', `❌ Помилка API (${r.status})`);
      return;
    }
  } catch (e) {
    showStatus('error', '❌ Помилка з\'єднання');
    return;
  }

  // Load job title
  if (prefs.default_job_id) {
    try {
      const r = await ttFetch(`/jobs/${prefs.default_job_id}`, key);
      if (r.ok) {
        const b = await r.json();
        const title = b?.data?.attributes?.['internal-name'] || b?.data?.attributes?.title || '—';
        document.getElementById('info-job').textContent = title;
      }
    } catch (e) {}
  }

  // Load location name
  if (prefs.default_loc_id) {
    try {
      const r = await ttFetch(`/locations/${prefs.default_loc_id}`, key);
      if (r.ok) {
        const b = await r.json();
        document.getElementById('info-loc').textContent = b?.data?.attributes?.name || '—';
      }
    } catch (e) {}
  }

  // Load department name
  if (prefs.default_dept_id) {
    try {
      const r = await ttFetch(`/departments/${prefs.default_dept_id}`, key);
      if (r.ok) {
        const b = await r.json();
        document.getElementById('info-dept').textContent = b?.data?.attributes?.name || '—';
      }
    } catch (e) {}
  }

  // Load role name
  if (prefs.default_role_id) {
    try {
      const r = await ttFetch(`/roles/${prefs.default_role_id}`, key);
      if (r.ok) {
        const b = await r.json();
        document.getElementById('info-role').textContent = b?.data?.attributes?.name || '—';
      }
    } catch (e) {}
  }
});

document.getElementById('btn-options').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});

document.getElementById('btn-help').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
});
