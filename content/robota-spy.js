// ============================================================
// Teamtailor Importera — content/robota-spy.js
// world: MAIN — запускається в page context до Angular
// Перехоплює fetch і XHR запити до employer-api.robota.ua
// і передає їх через postMessage у ISOLATED content script (robota.js)
// ============================================================
(function () {
  'use strict';

  function postSpy(url, body) {
    try {
      window.postMessage(
        { __ttSpy: 1, url: url, body: body.substring(0, 300000) },
        '*'
      );
    } catch (_) {}
  }

  // ── Fetch interception ──────────────────────────────────────
  const _origFetch = window.fetch;
  if (_origFetch) {
    window.fetch = function () {
      const req  = arguments[0];
      const url  = typeof req === 'string' ? req : (req?.url || '');
      const prom = _origFetch.apply(this, arguments);

      if (!url || url.indexOf('employer-api.robota.ua') === -1) return prom;

      return prom.then(function (resp) {
        try {
          resp.clone().text().then(function (body) {
            postSpy(url, body);
          }).catch(function () {});
        } catch (_) {}
        return resp;
      });
    };
  }

  // ── XHR interception ───────────────────────────────────────
  // Angular може використовувати XHR (HttpClient з XMLHttpRequest) замість fetch
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ttUrl = (typeof url === 'string') ? url : '';
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var url = this.__ttUrl || '';
    if (url.indexOf('employer-api.robota.ua') !== -1) {
      var xhr = this;
      xhr.addEventListener('load', function () {
        postSpy(url, xhr.responseText || '');
      });
    }
    return _origSend.apply(this, arguments);
  };

})();
