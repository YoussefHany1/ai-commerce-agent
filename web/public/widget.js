/**
 * AI Commerce Agent — storefront widget.
 *
 * Drop-in chat widget for a merchant's storefront. Dependency-free and framework-free
 * on purpose: it has to survive being pasted into a Shopify theme, a WordPress
 * footer, or a hand-written template, none of which are under our control and all of
 * which may already define globals we would otherwise collide with.
 *
 * Embed it with:
 *
 *   <script
 *     src="https://<app>/widget.js"
 *     data-api="https://<api>"
 *     data-key="aca_pub_..."
 *     data-store="My Store"
 *     defer></script>
 *
 * What it holds is the public embed key and nothing else. It cannot read the
 * merchant's data, change settings, or reach any admin surface — the key authorises
 * exactly one thing server-side, minting a guest session for its own store.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var api = (script.getAttribute('data-api') || '').replace(/\/+$/, '');
  var key = script.getAttribute('data-key') || '';
  var storeName = script.getAttribute('data-store') || 'the store';
  var accent = script.getAttribute('data-accent') || '#7c3aed';

  // Both are required. Without them every call would 401, and a silent failure here
  // looks to a merchant like a broken widget rather than a bad snippet.
  if (!api || !key) {
    if (window.console) console.warn('[aca-widget] missing data-api or data-key; widget disabled');
    return;
  }

  // Scoped per key on purpose. A single global key would let a shopper move from one
  // merchant's storefront to another's and carry the first store's token along, so the
  // second widget would attribute its clicks to the first store.
  var GUEST_KEY = 'aca_widget_guest:' + key;
  var session = null;
  var messages = [];
  var open = false;
  var el = {};

  function post(path, body, extraHeaders) {
    var headers = { 'Content-Type': 'application/json', 'x-embed-key': key };
    if (extraHeaders) {
      for (var h in extraHeaders) if (Object.prototype.hasOwnProperty.call(extraHeaders, h)) headers[h] = extraHeaders[h];
    }
    return fetch(api + path, {
      method: 'POST',
      headers: headers,
      // Same-origin only: the guest token lives in this tab and must not ride along
      // to the merchant's own requests.
      credentials: 'omit',
      body: JSON.stringify(body || {}),
    });
  }

  function readGuest() {
    try {
      return JSON.parse(window.localStorage.getItem(GUEST_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function writeGuest(guest) {
    try {
      window.localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
    } catch {
      /* private mode: the session simply lasts until the tab closes */
    }
  }

  /**
   * Returns a usable session, minting one if needed.
   *
   * Reused across page loads so a returning shopper keeps one conversation instead
   * of starting a new one — and so the attribution rows from two visits can be
   * joined by `markConversionsForOrder`.
   */
  function ensureSession() {
    if (session) return Promise.resolve(session);
    var stored = readGuest();
    if (stored && stored.token) {
      session = stored;
      return Promise.resolve(session);
    }
    // Ask for an email so a later order can be matched back to this conversation.
    // Entirely optional: a shopper who declines still gets a working widget, their
    // click is just less likely to become an attributed conversion.
    var email = null;
    try {
      email = window.prompt('Enter your email so we can follow up on your picks', '');
    } catch {
      email = null;
    }
    return post('/api/widget/session', email ? { email: email } : {}).then(function (res) {
      if (!res.ok) throw new Error('session_failed');
      return res.json();
    }).then(function (data) {
      session = data;
      writeGuest(data);
      return data;
    });
  }

  function elFrom(html) {
    var t = document.createElement('div');
    t.innerHTML = html;
    return t.firstElementChild;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(p) {
    var n = Number(p.price);
    if (!isFinite(n)) return '';
    try {
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + (p.currency ? ' ' + p.currency : '');
    } catch {
      return String(n);
    }
  }

  function renderMessages() {
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'user') {
        html += '<div class="aca-msg aca-msg--user">' + esc(m.content) + '</div>';
        continue;
      }
      html += '<div class="aca-msg aca-msg--bot">' + esc(m.content);
      if (m.products && m.products.length) {
        html += '<div class="aca-products">';
        for (var j = 0; j < m.products.length; j++) {
          // The id is the whole point: it is what POST /api/attributions/click
          // records, so a card without it would be invisible to the merchant's
          // Analytics page.
          html +=
            '<button type="button" class="aca-product" data-product-id="' + esc(m.products[j].id) +
            '" data-product-url="' + esc(m.products[j].url || '') + '">' +
            '<span class="aca-product__title">' + esc(m.products[j].title) + '</span>' +
            '<span class="aca-product__price">' + esc(money(m.products[j])) + '</span>' +
            '</button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    el.log.innerHTML = html;
    el.log.scrollTop = el.log.scrollHeight;
  }

  function setBusy(busy) {
    el.form.querySelector('button[type=submit]').disabled = busy;
    el.input.disabled = busy;
    if (busy) {
      var pending = elFrom('<div class="aca-msg aca-msg--bot aca-pending">Thinking…</div>');
      el.log.appendChild(pending);
      el.log.scrollTop = el.log.scrollHeight;
    } else {
      var p = el.log.querySelector('.aca-pending');
      if (p) p.parentNode.removeChild(p);
    }
  }

  function onProductClick(ev) {
    var btn = ev.target.closest ? ev.target.closest('.aca-product') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-product-id');
    var url = btn.getAttribute('data-product-url');
    ensureSession()
      .then(function (s) {
        return post('/api/attributions/click', { productId: id }, { Authorization: 'Bearer ' + s.token });
      })
      .catch(function () {
        /* attribution must never block the shopper */
      });
    if (url) window.open(url, '_blank', 'noopener');
  }

  function send(text) {
    var message = (text || '').trim();
    if (!message) return;
    messages.push({ role: 'user', content: message });
    renderMessages();
    setBusy(true);

    ensureSession()
      .then(function (s) {
        return post('/api/chat', { message: message }, { Authorization: 'Bearer ' + s.token });
      })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        messages.push({
          role: 'assistant',
          content: data.reply || '',
          products: (data.products || []).slice(0, 3),
        });
        setBusy(false);
        renderMessages();
      })
      .catch(function () {
        setBusy(false);
        messages.push({ role: 'assistant', content: "Sorry — I couldn't reach the store just now. Please try again." });
        renderMessages();
      });
  }

  function mount() {
    var root = elFrom(
      '<div class="aca-widget" style="--aca-accent:' + esc(accent) + '">' +
        '<button type="button" class="aca-launcher" aria-expanded="false" aria-label="Chat with ' + esc(storeName) + '">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3c-4.97 0-9 3.36-9 7.5 0 2.3 1.25 4.36 3.2 5.73L5.5 21l4.36-2.28c.69.16 1.4.24 2.14.24 4.97 0 9-3.36 9-7.5S16.97 3 12 3z"/></svg>' +
        '</button>' +
        '<section class="aca-panel" role="dialog" aria-label="Chat with ' + esc(storeName) + '" hidden>' +
          '<header class="aca-head">' +
            '<span class="aca-head__title">' + esc(storeName) + ' assistant</span>' +
            '<button type="button" class="aca-close" aria-label="Close">&times;</button>' +
          '</header>' +
          '<div class="aca-log"></div>' +
          '<form class="aca-form"><input class="aca-input" type="text" placeholder="Ask about a product…" autocomplete="off" aria-label="Message"><button type="submit" aria-label="Send">Send</button></form>' +
        '</section>' +
      '</div>'
    );

    var style = document.createElement('style');
    style.textContent =
      '.aca-widget{position:fixed;right:20px;bottom:20px;z-index:2147483000;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f2937}' +
      '.aca-launcher{width:56px;height:56px;border-radius:50%;border:0;background:var(--aca-accent,#7c3aed);color:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center}' +
      '.aca-panel{position:absolute;right:0;bottom:68px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.24);display:flex;flex-direction:column;overflow:hidden}' +
      '.aca-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--aca-accent,#7c3aed);color:#fff}' +
      '.aca-head__title{font-weight:600}' +
      '.aca-close{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer}' +
      '.aca-log{flex:1;overflow-y:auto;padding:12px;background:#f8fafc}' +
      '.aca-msg{max-width:86%;padding:8px 11px;border-radius:12px;margin-bottom:8px;white-space:pre-wrap;word-break:break-word}' +
      '.aca-msg--user{margin-left:auto;background:var(--aca-accent,#7c3aed);color:#fff;border-bottom-right-radius:3px}' +
      '.aca-msg--bot{background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:3px}' +
      '.aca-pending{color:#6b7280;font-style:italic}' +
      '.aca-products{margin-top:8px;display:flex;flex-direction:column;gap:6px}' +
      '.aca-product{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;cursor:pointer;font:inherit;color:inherit}' +
      '.aca-product:hover{border-color:var(--aca-accent,#7c3aed)}' +
      '.aca-product__title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.aca-product__price{font-weight:700;color:var(--aca-accent,#7c3aed);white-space:nowrap}' +
      '.aca-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb}' +
      '.aca-input{flex:1;padding:9px 11px;border:1px solid #d1d5db;border-radius:10px;font:inherit}' +
      '.aca-form button{padding:9px 14px;border:0;border-radius:10px;background:var(--aca-accent,#7c3aed);color:#fff;font-weight:600;cursor:pointer}';

    document.body.appendChild(style);
    document.body.appendChild(root);

    el.root = root;
    el.panel = root.querySelector('.aca-panel');
    el.log = root.querySelector('.aca-log');
    el.form = root.querySelector('.aca-form');
    el.input = root.querySelector('.aca-input');
    var launcher = root.querySelector('.aca-launcher');

    launcher.addEventListener('click', function () {
      open = !open;
      el.panel.hidden = !open;
      launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        if (!messages.length) {
          messages.push({
            role: 'assistant',
            content: 'Hi! Ask me about products and I’ll suggest what fits.',
          });
          renderMessages();
        }
        el.input.focus();
      }
    });

    root.querySelector('.aca-close').addEventListener('click', function () {
      open = false;
      el.panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
    });

    el.log.addEventListener('click', onProductClick);
    el.form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = el.input.value;
      el.input.value = '';
      send(v);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
