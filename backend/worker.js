// ============================================================
// Teamtailor Importera — Cloudflare Worker (backend cache)
//
// Зберігає маппінг {source}:{siteId} → TT candidate info.
// Дозволяє batch-перевірку 50 кандидатів за 1 запит (~30ms)
// замість 50 індивідуальних запитів до TT API.
//
// Deploy:
//   1. npx wrangler kv:namespace create TT_CACHE
//   2. Скопіюйте id у wrangler.toml
//   3. npx wrangler deploy
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-secret',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function checkAuth(request, env) {
  if (!env.SECRET) return true;               // без секрету — відкритий доступ
  const s = request.headers.get('x-secret') || '';
  return s === env.SECRET;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!checkAuth(request, env)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    // ── POST /check — batch-перевірка кандидатів ──────────────
    // Body: { ids: ["robota:98516070", "work:358470639", ...] }
    // Response: { "robota:98516070": { ttId, ttName, ttUrl, ts }, ... }
    // Відсутні ID → не включаються у відповідь
    if (url.pathname === '/check' && request.method === 'POST') {
      try {
        const body = await request.json();
        const ids   = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        if (!ids.length) return json({});

        // Паралельно дістаємо всі ключі з KV
        const entries = await Promise.all(
          ids.map(async id => {
            const val = await env.TT_CACHE.get(String(id), 'json');
            return [id, val];
          })
        );

        const result = {};
        for (const [id, val] of entries) {
          if (val) result[id] = val;
        }
        return json(result);
      } catch (e) {
        return json({ ok: false, error: String(e) }, 400);
      }
    }

    // ── POST /save — зберегти маппінг після імпорту ───────────
    // Body: { id: "robota:98516070", ttId: "12345", ttName: "Іван Петров", ttUrl: "https://..." }
    if (url.pathname === '/save' && request.method === 'POST') {
      try {
        const { id, ttId, ttName, ttUrl } = await request.json();
        if (!id || !ttId) return json({ ok: false, error: 'id and ttId required' }, 400);

        await env.TT_CACHE.put(
          String(id),
          JSON.stringify({ ttId: String(ttId), ttName: ttName || '', ttUrl: ttUrl || '', ts: Date.now() }),
          { expirationTtl: 60 * 60 * 24 * 365 }  // 1 рік — маппінги стабільні
        );
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 400);
      }
    }

    // ── POST /delete — видалити маппінг (кандидата видалили з TT) ─
    // Body: { id: "robota:98516070" }
    if (url.pathname === '/delete' && request.method === 'POST') {
      try {
        const { id } = await request.json();
        if (id) await env.TT_CACHE.delete(String(id));
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 400);
      }
    }

    // ── GET /stats — статистика (для відладки) ────────────────
    if (url.pathname === '/stats' && request.method === 'GET') {
      try {
        const list = await env.TT_CACHE.list({ limit: 1000 });
        return json({ keys: list.keys.length, truncated: !list.list_complete });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};
