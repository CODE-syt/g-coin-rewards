'use strict';
/* Shared helpers: safe HTML templating (escapes by default), API client, toasts, dialogs. */
(function () {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
  class Safe { constructor(s) { this.s = s; } }
  const fmt = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === false || v == null ? '' : esc(v));
  const html = (strings, ...vals) => new Safe(strings.reduce((a, s, i) => a + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
  const mount = (el, tpl) => { el.innerHTML = tpl instanceof Safe ? tpl.s : esc(tpl); };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
  const num = (n) => Number(n || 0).toLocaleString();

  function makeApi(base, state) {
    async function call(method, path, body, headers = {}, retry = true) {
      const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
      if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
      if (method !== 'GET' && state.csrf) opts.headers['X-CSRF-Token'] = state.csrf;
      let res;
      try { res = await fetch(base + path, opts); } catch { const e = new Error('Network problem. Check your connection and try again.'); e.code = 'NETWORK'; throw e; }
      let data = null;
      try { data = await res.json(); } catch { /* empty body */ }
      if (!res.ok) {
        const err = new Error((data && data.error && data.error.message) || 'Something went wrong. Please try again.');
        err.status = res.status; err.code = data && data.error && data.error.code; err.fields = data && data.error && data.error.fields;
        if (err.code === 'CSRF' && retry && state.refresh) { await state.refresh(); return call(method, path, body, headers, false); }
        throw err;
      }
      return data;
    }
    return { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b === undefined ? {} : b, h), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b || {}) };
  }

  function toast(msg, kind = 'info') {
    let host = $('#toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    const t = document.createElement('div'); t.className = `toast toast-${kind}`; t.textContent = msg; host.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3500);
  }

  // Modal built on <dialog>. `body` is a Safe template; `onReady(dialog)` wires up behavior.
  function modal(title, body, onReady) {
    const d = document.createElement('dialog'); d.className = 'modal';
    mount(d, html`<div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">&times;</button></div><div class="modal-body">${body}</div>`);
    document.body.appendChild(d);
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
    d.addEventListener('close', () => d.remove());
    d.showModal();
    if (onReady) onReady(d);
    return d;
  }

  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, fields = '' }) {
    return new Promise((resolve) => {
      let result = null;
      const d = modal(title, html`<p>${message}</p><form class="stack" id="cf">${fields ? html`${fields}` : ''}<div class="row end gap"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${confirmText}</button></div></form>`, (dlg) => {
        const first = $('input', dlg); if (first) first.focus();
        $('#cf', dlg).addEventListener('submit', (e) => { e.preventDefault(); result = Object.fromEntries(new FormData(e.target)); dlg.close(); });
      });
      d.addEventListener('close', () => resolve(result));
    });
  }

  const skeleton = (n = 3) => html`<div class="skeleton-list" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => html`<div class="skeleton"></div>`)}</div>`;
  const empty = (icon, title, text, cta = '') => html`<div class="empty"><div class="empty-ic" aria-hidden="true">${icon}</div><h3>${title}</h3><p>${text}</p>${cta}</div>`;
  const errorBox = (msg, retry = true) => html`<div class="error-box" role="alert"><p>${msg}</p>${retry ? html`<button class="btn" data-action="retry">Try again</button>` : ''}</div>`;
  const pager = (p, action) => (p.pages > 1 ? html`<nav class="pager" aria-label="Pagination"><button class="btn btn-sm" data-action="${action}" data-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>&larr; Prev</button><span>Page ${p.page} of ${p.pages}</span><button class="btn btn-sm" data-action="${action}" data-page="${p.page + 1}" ${p.page >= p.pages ? 'disabled' : ''}>Next &rarr;</button></nav>` : '');

  async function withBusy(btn, fn) {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.classList.add('busy'); }
    try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); } }
  }

  window.GC = { esc, html, mount, Safe, $, $$, fmtDate, fmtDay, num, makeApi, toast, modal, confirmDialog, skeleton, empty, errorBox, pager, withBusy };
})();
