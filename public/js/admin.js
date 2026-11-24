'use strict';
(function () {
  const { html, mount, $, $$, fmtDate, num, makeApi, toast, modal, confirmDialog, skeleton, empty, errorBox, pager, withBusy, esc } = GC;
  const state = { csrf: '', admin: null, mfaRequired: false, route: null };
  state.refresh = async () => { const s = await api.get('/session'); state.csrf = s.csrfToken; state.admin = s.admin; state.mfaRequired = s.mfaEnrollmentRequired; return s; };
  const api = makeApi('/api/admin', state);
  const app = $('#app');
  const TABS = [['dashboard', 'Dashboard'], ['rewards', 'Rewards'], ['users', 'Users'], ['transactions', 'Transactions'], ['redemptions', 'Redemptions'], ['inventory', 'Inventory'], ['audit', 'Audit log'], ['security', 'Security']];
  const canManage = () => ['admin', 'superadmin'].includes(state.admin.role);
  const isSuper = () => state.admin.role === 'superadmin';
  const chip = (t, k = '') => html`<span class="chip ${k}">${t}</span>`;
  const STATUS = { available: 'ok', assigned: 'warn', redeemed: 'info', completed: 'ok', pending: 'warn', failed: 'bad', active: 'ok', inactive: '' };
  const go = (p) => { location.hash = `#/${p}`; };
  const parse = () => { const [path, q = ''] = location.hash.replace(/^#\/?/, '').split('?'); const [name, arg] = path.split('/'); return { name: name || 'dashboard', arg, query: new URLSearchParams(q) }; };

  async function route() {
    if (!state.admin) return renderLogin();
    const r = parse(); state.route = r;
    if (state.mfaRequired && r.name !== 'security') return go('security');
    if (!TABS.some((t) => t[0] === r.name)) return go('dashboard');
    mount(app, html`<div class="admin-shell"><nav class="admin-side" aria-label="Admin"><b class="brand">🛡️ Admin</b>${TABS.map(([k, l]) => html`<a href="#/${k}" ${k === r.name ? 'aria-current=page' : ''}>${l}</a>`)}<span class="spacer"></span><span class="muted small wrap-any">${state.admin.email}<br>${state.admin.role}</span><button class="btn btn-sm" data-action="logout">Sign out</button></nav><main class="admin-main" id="main"><div id="view">${skeleton(3)}</div></main></div>`);
    try { await views[r.name]($('#view'), r); } catch (e) { if (e.status === 401) { state.admin = null; return route(); } mount($('#view'), errorBox(e.message)); }
  }

  function renderLogin(needCode = false, prefill = {}) {
    mount(app, html`<main class="login card" id="main"><h1>Admin sign-in</h1><p class="muted">Authorized staff only. All sign-ins are logged.</p>
      <form class="stack tl" id="lf"><label>Email<input type="email" name="email" autocomplete="username" required value="${prefill.email || ''}"></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <label class="${needCode ? '' : 'hidden'}" id="codeL">Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></label>
      <div id="le" class="field-error" role="alert"></div><button class="btn btn-primary" type="submit">Sign in</button></form></main>`);
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target; const body = Object.fromEntries(new FormData(f)); if (!body.code) delete body.code;
      await withBusy($('button', f), async () => {
        try { const out = await api.post('/login', body); state.admin = out.admin; state.csrf = out.csrfToken; state.mfaRequired = out.mfaEnrollmentRequired; go(state.mfaRequired ? 'security' : 'dashboard'); route(); }
        catch (er) { $('#le').textContent = er.message; if (er.code === 'MFA_REQUIRED') { $('#codeL').classList.remove('hidden'); $('[name=code]').focus(); } }
      });
    });
  }

  const views = {};

  views.dashboard = async (view) => {
    const s = await api.get('/stats'); const rd = s.redemptions || {}; const v = s.vouchers || {};
    mount(view, html`<h1>Dashboard</h1><div class="stats">
      <div class="card stat"><b>${num(s.users)}</b><span>Users (${num(s.newUsers7d)} new this week)</span></div>
      <div class="card stat"><b>${num(s.coinsInCirculation)}</b><span>G Coins in circulation</span></div>
      <div class="card stat"><b>${num(s.coinsSpent)}</b><span>G Coins spent</span></div>
      <div class="card stat"><b>${num(s.activeRewards)}</b><span>Active rewards</span></div>
      <div class="card stat"><b>${num(rd.completed)}</b><span>Completed redemptions</span></div>
      <div class="card stat"><b>${num(v.available)}</b><span>Voucher codes available</span></div></div>
      <div class="card"><h3>Voucher codes</h3><p>${chip(`${num(v.available)} available`, 'ok')} ${chip(`${num(v.assigned)} assigned`, 'warn')} ${chip(`${num(v.redeemed)} redeemed`, 'info')}</p>
      ${rd.pending ? html`<p>${chip(`${rd.pending} pending`, 'warn')} redemptions are in progress or being recovered.</p>` : ''}</div>`);
  };

  const table = (head, rows) => html`<div class="table-wrap"><table><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const listView = (title, path, head, rowFn, extra = '') => async (view, r) => {
    const page = Number(r.query.get('page')) || 1; const qs = new URLSearchParams(r.query); qs.set('page', page);
    mount(view, html`<h1>${title}</h1>${extra}<div id="tb">${skeleton(4)}</div>`);
    wireFilters(r);
    const d = await api.get(`${path}?${qs}`);
    mount($('#tb'), d.items.length ? html`${table(head, d.items.map(rowFn))}<p class="muted small">${num(d.total)} total</p>${pager(d, 'page')}` : empty('📭', 'Nothing here yet', 'No records match.'));
  };
  function wireFilters(r) {
    const f = $('#flt'); if (!f) return;
    $$('[name]', f).forEach((el) => { el.value = r.query.get(el.name) || ''; });
    f.addEventListener('submit', (e) => { e.preventDefault(); const q = new URLSearchParams(); new FormData(f).forEach((v, k) => v && q.set(k, v)); go(`${r.name}?${q}`); });
  }
  const filterBar = (...fields) => html`<form class="toolbar" id="flt">${fields}<button class="btn">Filter</button></form>`;

  views.users = listView('Users', '/users', ['Name', 'Email', 'Balance', 'Joined', 'Last sign-in'], (u) => html`<tr><td>${u.name}</td><td>${u.email}</td><td><b>${num(u.balance)}</b></td><td>${fmtDate(u.createdAt)}</td><td>${fmtDate(u.lastLoginAt)}</td></tr>`, filterBar(html`<input name="q" placeholder="Search name or email" maxlength="60" aria-label="Search">`));
  views.transactions = listView('Transactions', '/transactions', ['When', 'User', 'Type', 'Description', 'Amount'], (t) => html`<tr><td>${fmtDate(t.createdAt)}</td><td>${t.user ? t.user.email : '—'}</td><td>${chip(t.type.replace('_', ' '))}</td><td>${t.description}</td><td class="amt ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${t.amount}</td></tr>`, filterBar(html`<select name="type" aria-label="Type"><option value="">All types</option><option value="signup_bonus">Signup bonus</option><option value="share_bonus">Share bonus</option><option value="redemption">Redemption</option></select>`));
  views.redemptions = listView('Redemptions', '/redemptions', ['When', 'User', 'Reward', 'Price', 'Voucher', 'Status'], (x) => html`<tr><td>${fmtDate(x.createdAt)}</td><td>${x.user ? x.user.email : '—'}</td><td>${x.reward}</td><td>${x.price}</td><td class="mono">${x.voucher ? x.voucher.maskedCode : '—'}</td><td>${chip(x.status + (x.failCode ? ` (${x.failCode})` : ''), STATUS[x.status])}</td></tr>`, filterBar(html`<select name="status" aria-label="Status"><option value="">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select>`));
  views.audit = listView('Audit log', '/audit', ['When', 'Admin', 'Action', 'Target', 'Details', 'IP'], (a) => html`<tr><td>${fmtDate(a.at)}</td><td>${a.admin || '—'}</td><td class="mono">${a.action}</td><td class="mono small">${a.targetType || ''} ${a.targetId || ''}</td><td class="small">${Object.entries(a.details || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td><td class="small">${a.ip || ''}</td></tr>`);

  views.inventory = async (view) => {
    const d = await api.get('/inventory');
    mount(view, html`<h1>Reward inventory</h1>${d.items.length ? table(['Reward', 'Status', 'Mode', 'Available', 'Assigned', 'Redeemed', 'Stock'], d.items.map((i) => html`<tr><td>${i.name}</td><td>${chip(i.status, STATUS[i.status])}</td><td>${i.voucherMode}</td>
      <td>${i.voucherMode === 'none' ? '—' : html`<b class="${i.inventory.available < 3 ? 'amt neg' : ''}">${i.inventory.available}</b>`}</td><td>${i.voucherMode === 'none' ? '—' : i.inventory.assigned}</td><td>${i.voucherMode === 'none' ? i.redeemedCount : i.inventory.redeemed}</td><td>${i.voucherMode === 'none' ? (i.stock === null ? 'Unlimited' : i.stock) : '—'}</td></tr>`)) : empty('📦', 'No rewards', 'Create a reward first.')}`);
  };

  // ---- Rewards ------------------------------------------------------------
  views.rewards = async (view, r) => {
    const page = Number(r.query.get('page')) || 1;
    mount(view, html`<div class="row between wrap gap"><h1>Rewards</h1>${canManage() ? html`<button class="btn btn-primary" data-action="new-reward">+ New reward</button>` : ''}</div>${filterBar(html`<input name="q" placeholder="Search rewards" aria-label="Search" maxlength="60">`, html`<select name="status" aria-label="Status"><option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select>`)}<div id="tb">${skeleton(4)}</div>`);
    wireFilters(r);
    const qs = new URLSearchParams(r.query); qs.set('page', page);
    const d = await api.get(`/rewards?${qs}`);
    state.rewards = new Map(d.items.map((x) => [x.id, x]));
    mount($('#tb'), d.items.length ? html`${table(['Reward', 'Price', 'Status', 'Voucher mode', 'Inventory', 'Actions'], d.items.map((x) => html`<tr><td><b>${x.name}</b></td><td>${num(x.price)}</td><td>${chip(x.status, STATUS[x.status])}</td><td>${x.voucherMode}</td>
      <td class="small">${x.voucherMode === 'none' ? (x.stock === null ? 'Unlimited' : `${x.stock} in stock`) : `${x.inventory.available} available · ${x.inventory.assigned} assigned · ${x.inventory.redeemed} redeemed`}</td>
      <td><div class="row gap wrap">${x.voucherMode !== 'none' ? html`<button class="btn btn-sm" data-action="vouchers" data-id="${x.id}">Codes</button>` : ''}${canManage() ? html`<button class="btn btn-sm" data-action="edit-reward" data-id="${x.id}">Edit</button><button class="btn btn-sm" data-action="toggle" data-id="${x.id}">${x.status === 'active' ? 'Deactivate' : 'Activate'}</button>` : ''}${isSuper() ? html`<button class="btn btn-sm btn-danger" data-action="delete-reward" data-id="${x.id}">Remove</button>` : ''}</div></td></tr>`))}${pager(d, 'page')}` : empty('🎁', 'No rewards', 'Create your first reward.'));
  };

  const dt = (d) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  function rewardForm(x = {}) {
    const isNew = !x.id;
    modal(isNew ? 'New reward' : `Edit: ${x.name}`, html`<form class="stack" id="rf">
      <label>Name<input name="name" required minlength="2" maxlength="120" value="${x.name || ''}"></label>
      <label>Description<textarea name="description" required maxlength="2000">${x.description || ''}</textarea></label>
      <label>Image URL <span class="hint">https:// link or /img/... path</span><input name="imageUrl" maxlength="500" value="${x.imageUrl || ''}" placeholder="https://…"></label>
      <div class="form-grid two"><label>Price (G Coins)<input type="number" name="price" min="1" max="1000000" step="1" required value="${x.price ?? ''}"></label>
        <label>Status<select name="status"><option value="inactive" ${x.status !== 'active' ? 'selected' : ''}>Inactive (hidden)</option><option value="active" ${x.status === 'active' ? 'selected' : ''}>Active</option></select></label></div>
      <label>Voucher behavior<select name="voucherMode"><option value="none" ${x.voucherMode === 'none' || isNew ? 'selected' : ''}>No codes (uses stock count)</option><option value="reveal" ${x.voucherMode === 'reveal' ? 'selected' : ''}>Assign a code and reveal it to the redeemer</option><option value="hidden" ${x.voucherMode === 'hidden' ? 'selected' : ''}>Assign a code but never show it in the app</option></select></label>
      <div class="form-grid two"><label>Stock <span class="hint">only for “No codes”; blank = unlimited</span><input type="number" name="stock" min="0" step="1" value="${x.stock ?? ''}"></label>
        <label>Limit per user <span class="hint">blank = no limit</span><input type="number" name="perUserLimit" min="1" step="1" value="${x.perUserLimit ?? ''}"></label></div>
      <div class="form-grid two"><label>Available from<input type="datetime-local" name="startsAt" value="${dt(x.startsAt)}"></label><label>Available until<input type="datetime-local" name="endsAt" value="${dt(x.endsAt)}"></label></div>
      <label>Redemption details <span class="hint">shown to users</span><textarea name="redemptionDetails" maxlength="2000">${x.redemptionDetails || ''}</textarea></label>
      <label>Sort order<input type="number" name="sortOrder" step="1" value="${x.sortOrder ?? 0}"></label>
      <div id="rfe" class="field-error" role="alert"></div>
      <div class="row end gap"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">${isNew ? 'Create' : 'Save changes'}</button></div></form>`, (dlg) => {
      $('#rf', dlg).addEventListener('submit', async (e) => {
        e.preventDefault(); const f = new FormData(e.target); const body = {};
        for (const [k, v] of f.entries()) body[k] = v;
        ['price', 'sortOrder'].forEach((k) => { body[k] = Number(body[k] || 0); });
        ['stock', 'perUserLimit'].forEach((k) => { body[k] = body[k] === '' ? null : Number(body[k]); });
        ['startsAt', 'endsAt'].forEach((k) => { body[k] = body[k] ? new Date(body[k]).toISOString() : null; });
        if (body.voucherMode !== 'none') body.stock = null;
        if (!isNew && body.voucherMode !== x.voucherMode) {
          const ok = await confirmDialog({ title: 'Change voucher behavior?', message: 'Changing how vouchers work affects future redemptions only. Continue?', confirmText: 'Yes, change it' });
          if (!ok) return;
        }
        if (!isNew && body.status === 'active' && x.status !== 'active' && body.price < 1) return;
        await withBusy($('[type=submit]', dlg), async () => {
          try { await (isNew ? api.post('/rewards', body) : api.patch(`/rewards/${x.id}`, body)); toast('Saved', 'success'); dlg.close(); route(); }
          catch (er) { $('#rfe', dlg).textContent = er.fields ? er.fields.map((i) => `${i.path}: ${i.message}`).join('; ') : er.message; }
        });
      });
    });
  }

  async function voucherManager(id, page = 1) {
    const reward = state.rewards.get(id);
    const d = await api.get(`/rewards/${id}/vouchers?page=${page}&limit=15`);
    const dlg = $('#vm') || modal(`Voucher codes: ${reward.name}`, html`<div id="vmb"></div>`);
    dlg.id = 'vm';
    mount($('#vmb', dlg), html`<p class="muted small">Codes are stored encrypted. For security the full codes are never shown here, only the last 4 characters.</p>
      ${canManage() ? html`<form id="vf" class="stack"><label>Add codes <span class="hint">one per line, up to 1000. Duplicates are skipped.</span><textarea name="codes" placeholder="CODE-1234&#10;CODE-5678" required></textarea></label><div class="row end"><button class="btn btn-primary" type="submit">Add codes</button></div></form>` : ''}
      <h3 class="mt-1">Existing codes (${num(d.total)})</h3>
      ${d.items.length ? table(['Code', 'Status', 'Assigned to', 'Date', ''], d.items.map((v) => html`<tr><td class="mono">${v.maskedCode}</td><td>${chip(v.status, STATUS[v.status])}</td><td class="small">${v.assignedTo || '—'}</td><td class="small">${fmtDate(v.redeemedAt || v.assignedAt || v.createdAt)}</td><td>${isSuper() && v.status === 'available' ? html`<button class="btn btn-sm btn-danger" data-action="del-voucher" data-vid="${v.id}">Delete</button>` : ''}</td></tr>`)) : empty('🎟️', 'No codes yet', 'Add codes above.')}
      ${d.pages > 1 ? html`<nav class="pager"><button class="btn btn-sm" data-vp="${page - 1}" ${page <= 1 ? 'disabled' : ''}>&larr;</button><span>Page ${page} of ${d.pages}</span><button class="btn btn-sm" data-vp="${page + 1}" ${page >= d.pages ? 'disabled' : ''}>&rarr;</button></nav>` : ''}`);
    const vf = $('#vf', dlg);
    if (vf) vf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const codes = new FormData(vf).get('codes').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!codes.length) return;
      await withBusy($('button', vf), async () => {
        try { const out = await api.post(`/rewards/${id}/vouchers`, { codes }); toast(`Added ${out.added}. Skipped ${out.duplicates} duplicate and ${out.invalid} invalid.`, out.added ? 'success' : 'info'); voucherManager(id, 1); route(); }
        catch (er) { toast(er.message, 'error'); }
      });
    });
    $$('[data-vp]', dlg).forEach((b) => b.addEventListener('click', () => voucherManager(id, Number(b.dataset.vp))));
    $$('[data-vid]', dlg).forEach((b) => b.addEventListener('click', () => sensitive({ title: 'Delete voucher code', message: 'Permanently delete this unassigned code? This cannot be undone.', confirmText: 'Delete code' }, (auth) => api.del(`/vouchers/${b.dataset.vid}`, auth), () => voucherManager(id, page))));
  }

  // Sensitive actions: ask for the admin's password (and MFA code if enrolled) again.
  async function sensitive(opts, call, after) {
    const fields = html`<label>Your password<input type="password" name="confirmPassword" autocomplete="current-password" required></label>${state.admin.mfaEnabled ? html`<label>Authenticator code<input name="confirmCode" inputmode="numeric" maxlength="10" required></label>` : ''}`;
    const auth = await confirmDialog({ ...opts, danger: true, fields });
    if (!auth) return;
    try { await call(auth); toast('Done', 'success'); if (after) after(); else route(); } catch (e) { toast(e.message, 'error'); }
  }

  views.security = async (view) => {
    mount(view, html`<h1>Security</h1>${state.mfaRequired ? html`<div class="error-box">Multi-factor authentication is required. Set it up to continue.</div><br>` : ''}
      <div class="card stack"><h2>Multi-factor authentication</h2>
      <p>Status: ${state.admin.mfaEnabled ? chip('Enabled', 'ok') : chip('Not enabled', 'warn')}</p>
      ${state.admin.mfaEnabled ? html`<button class="btn" data-action="mfa-off" ${state.mfaRequired ? 'disabled' : ''}>Disable MFA</button>` : html`<button class="btn btn-primary" data-action="mfa-on">Set up authenticator app</button>`}</div>`);
  };

  async function mfaSetup() {
    try {
      const s = await api.post('/mfa/setup');
      modal('Set up MFA', html`<p>Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code.</p><img class="qr" src="${s.qrDataUrl}" alt="MFA QR code" width="220" height="220"><p class="small muted center wrap-any">Manual key: <span class="mono">${s.secret}</span></p>
        <form class="stack" id="mf"><label>6-digit code<input name="code" inputmode="numeric" maxlength="10" required autocomplete="one-time-code"></label><div class="field-error" id="mfe" role="alert"></div><button class="btn btn-primary">Enable MFA</button></form>`, (dlg) => {
        $('#mf', dlg).addEventListener('submit', async (e) => {
          e.preventDefault();
          try { await api.post('/mfa/enable', { code: new FormData(e.target).get('code') }); state.admin.mfaEnabled = true; state.mfaRequired = false; dlg.close(); toast('MFA enabled', 'success'); route(); }
          catch (er) { $('#mfe', dlg).textContent = er.message; }
        });
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]'); if (!t) return; const a = t.dataset.action;
    if (a === 'new-reward') rewardForm();
    else if (a === 'edit-reward') rewardForm(state.rewards.get(t.dataset.id));
    else if (a === 'vouchers') voucherManager(t.dataset.id);
    else if (a === 'toggle') {
      const x = state.rewards.get(t.dataset.id); const to = x.status === 'active' ? 'inactive' : 'active';
      const ok = await confirmDialog({ title: `${to === 'active' ? 'Activate' : 'Deactivate'} reward`, message: `${to === 'active' ? 'Make' : 'Hide'} “${x.name}” ${to === 'active' ? 'visible to' : 'from'} users?`, confirmText: 'Confirm' });
      if (!ok) return;
      try { await api.patch(`/rewards/${x.id}`, { status: to }); toast('Updated', 'success'); route(); } catch (er) { toast(er.message, 'error'); }
    } else if (a === 'delete-reward') {
      const x = state.rewards.get(t.dataset.id);
      sensitive({ title: 'Remove reward', message: `Remove “${x.name}”? It disappears for users immediately. Past redemptions are kept.`, confirmText: 'Remove reward' }, (auth) => api.del(`/rewards/${x.id}`, auth));
    } else if (a === 'mfa-on') mfaSetup();
    else if (a === 'mfa-off') sensitive({ title: 'Disable MFA', message: 'This makes your account easier to compromise.', confirmText: 'Disable MFA' }, (auth) => api.post('/mfa/disable', auth), async () => { await state.refresh(); route(); });
    else if (a === 'page') { const q = new URLSearchParams(state.route.query); q.set('page', t.dataset.page); go(`${state.route.name}?${q}`); }
    else if (a === 'retry') route();
    else if (a === 'logout') { try { await api.post('/logout'); } catch { /* ignore */ } state.admin = null; await state.refresh(); route(); }
  });

  (async function boot() {
    try { await state.refresh(); window.addEventListener('hashchange', route); route(); }
    catch { mount(app, html`<main class="login">${errorBox('Cannot reach the server.')}</main>`); }
  })();
})();
