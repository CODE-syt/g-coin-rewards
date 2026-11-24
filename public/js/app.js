'use strict';
(function () {
  const { html, mount, $, $$, fmtDate, fmtDay, num, makeApi, toast, modal, confirmDialog, skeleton, empty, errorBox, pager, withBusy } = GC;

  const state = { csrf: '', user: null, config: null, route: null, chat: { open: false, history: [] } };
  state.refresh = async () => { const s = await rawApi.get('/session'); state.csrf = s.csrfToken; state.user = s.user; return s; };
  const rawApi = makeApi('/api', state);
  const api = rawApi;
  const app = $('#app');

  const NAV = [
    ['home', 'Home', '🏠'], ['rewards', 'Rewards', '🎁'], ['redemptions', 'My Redemptions', '🎟️'], ['share', 'Share & Earn', '🔗'], ['profile', 'Profile', '👤'],
  ];
  const SHORT = { redemptions: 'Redeemed', share: 'Share' };
  const AVAIL = { available: ['Available', 'ok'], low: ['Low stock', 'warn'], out_of_stock: ['Out of stock', 'bad'], scheduled: ['Coming soon', 'info'], ended: ['Ended', 'bad'], unavailable: ['Unavailable', 'bad'] };
  const availChip = (a) => { const [t, k] = AVAIL[a] || AVAIL.unavailable; return html`<span class="chip ${k}">${t}</span>`; };
  const coin = html`<span class="coin" aria-hidden="true">G</span>`;

  const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

  // ---- Routing ------------------------------------------------------------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'home', arg: parts[1], query: new URLSearchParams(query) };
  }
  const go = (path) => { location.hash = `#/${path}`; };

  async function route() {
    const r = parseHash();
    state.route = r;
    if (!state.user) return renderLogin(r);
    const known = NAV.some((n) => n[0] === r.name);
    if (!known) return go('home');
    renderShell(r);
    const view = $('#view');
    try { await views[r.name](view, r); } catch (err) { handleViewError(view, err); }
    window.scrollTo(0, 0);
    const h = $('#view h1'); if (h) { h.setAttribute('tabindex', '-1'); }
  }

  function handleViewError(view, err) {
    if (err.status === 401) { state.user = null; return route(); }
    mount(view, errorBox(err.message));
  }

  function renderShell(r) {
    if (!$('#shell')) {
      mount(app, html`<div id="shell">
        <header class="topbar"><div class="topbar-in">
          <a class="brand" href="#/home"><img src="/img/logo.svg" alt="">G Coin Rewards</a>
          <nav class="nav" aria-label="Main">${NAV.map(([k, label]) => html`<a href="#/${k}" data-nav="${k}">${label}</a>`)}</nav>
          <span class="spacer"></span>
          <a class="balance" href="#/profile" aria-label="Your balance" id="bal"></a>
        </div></header>
        <main id="main"><div id="view"></div></main>
        <nav class="tabbar" aria-label="Main">${NAV.map(([k, label, ic]) => html`<a href="#/${k}" data-nav="${k}"><span class="ic" aria-hidden="true">${ic}</span>${SHORT[k] || label}</a>`)}</nav>
        <div id="chat-root"></div>
      </div>`);
      if (state.config.chatbotEnabled) renderChat();
    }
    updateBalance();
    $$('[data-nav]').forEach((a) => (a.dataset.nav === r.name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  }

  function updateBalance(b) {
    if (typeof b === 'number') state.user.balance = b;
    const el = $('#bal');
    if (el) mount(el, html`${coin}<span>${num(state.user.balance)}</span>`);
  }

  // ---- Login --------------------------------------------------------------
  function renderLogin(r) {
    const err = r.query.get('error');
    const MSG = { access_denied: 'Sign-in was cancelled.', invalid_state: 'Your sign-in session expired. Please try again.', google_failed: 'Google sign-in failed. Please try again.', email_not_verified: 'Your Google email is not verified.', google_not_configured: 'Google sign-in is not configured on this server yet.' };
    const c = state.config;
    mount(app, html`<main id="main" class="login card">
      <img class="logo" src="/img/logo.svg" alt="G Coin Rewards logo">
      <h1>G Coin Rewards</h1>
      <p class="muted">Earn G Coins, share rewards with friends, and redeem them for real perks.</p>
      <p><span class="chip ok">🎉 New members get ${c.signupBonus} G Coins on first sign-in</span></p>
      ${err ? html`<div class="error-box" role="alert">${MSG[err] || 'Sign-in failed.'}</div><br>` : ''}
      ${c.googleEnabled ? html`<a class="gbtn" href="/api/auth/google"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.2A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z"/></svg>Continue with Google</a>
        <p class="muted small">We only receive your verified name and email from Google. We never see or store your Google password.</p>` : ''}
      ${c.devLoginEnabled ? html`<form class="stack card tl" id="dev"><h3>Developer sign-in <span class="chip warn">local only</span></h3><label>Email<input name="email" type="email" required value="demo@example.com"></label><label>Name<input name="name" value="Demo User"></label><button class="btn btn-primary" type="submit">Sign in (dev)</button></form>` : ''}
      ${!c.googleEnabled && !c.devLoginEnabled ? html`<div class="error-box">Sign-in is not configured. Ask the site owner to set up Google OAuth.</div>` : ''}
    </main>`);
    const dev = $('#dev');
    if (dev) dev.addEventListener('submit', async (e) => {
      e.preventDefault();
      await withBusy($('button', dev), async () => {
        try {
          const out = await api.post('/auth/dev-login', Object.fromEntries(new FormData(dev)));
          state.user = out.user; state.csrf = out.csrfToken; app.textContent = '';
          go(out.isNew ? 'home?welcome=1' : 'home'); route();
        } catch (er) { toast(er.message, 'error'); }
      });
    });
  }

  // ---- Reward cards & redemption -----------------------------------------
  const rewardCard = (r) => html`<article class="card reward">
    ${r.imageUrl ? html`<img src="${r.imageUrl}" alt="" loading="lazy">` : html`<div class="img-ph" aria-hidden="true">🎁</div>`}
    <div class="reward-body">
      <div class="row between gap"><h3>${r.name}</h3>${availChip(r.availability)}</div>
      <p>${r.description}</p>
      <div class="reward-foot"><span class="price">${coin} ${num(r.price)}</span><button class="btn btn-sm" data-action="reward" data-id="${r.id}">View</button></div>
    </div></article>`;

  async function openReward(id) {
    let reward;
    try { reward = (await api.get(`/rewards/${id}`)).reward; } catch (e) { return toast(e.message, 'error'); }
    const can = state.user.balance >= reward.price;
    const d = modal(reward.name, html`
      ${reward.imageUrl ? html`<img class="hero-img" src="${reward.imageUrl}" alt="">` : ''}
      <p>${reward.description}</p>
      <dl class="kv"><dt>Price</dt><dd>${coin} ${num(reward.price)} G Coins</dd><dt>Status</dt><dd>${availChip(reward.availability)}</dd>
        <dt>Voucher</dt><dd>${reward.revealsVoucher ? 'Code shown in My Redemptions after you redeem' : 'No code is shown in the app. Follow the redemption details.'}</dd>
        ${reward.perUserLimit ? html`<dt>Limit</dt><dd>${reward.perUserLimit} per person</dd>` : ''}
        ${reward.endsAt ? html`<dt>Ends</dt><dd>${fmtDay(reward.endsAt)}</dd>` : ''}</dl>
      ${reward.redemptionDetails ? html`<h3>How to use it</h3><p class="muted">${reward.redemptionDetails}</p>` : ''}
      <div class="row gap wrap"><button class="btn btn-primary" data-act="redeem" ${reward.redeemable && can ? '' : 'disabled'}>Redeem for ${num(reward.price)} G Coins</button><button class="btn" data-act="share">Share &amp; earn ${state.config.shareBonus}</button></div>
      ${!reward.redeemable ? html`<p class="muted small">This reward cannot be redeemed right now.</p>` : !can ? html`<p class="muted small">You need ${num(reward.price - state.user.balance)} more G Coins. <a href="#/share" data-close>Earn some by sharing</a>.</p>` : ''}`,
    (dlg) => {
      $('[data-act=share]', dlg).addEventListener('click', () => { dlg.close(); go(`share?reward=${reward.id}`); });
      $('[data-act=redeem]', dlg).addEventListener('click', async (e) => {
        const ok = await confirmDialog({ title: 'Confirm redemption', message: `Redeem “${reward.name}” for ${num(reward.price)} G Coins? Your balance will go from ${num(state.user.balance)} to ${num(state.user.balance - reward.price)}. This cannot be undone.`, confirmText: 'Yes, redeem' });
        if (!ok) return;
        await withBusy(e.target, async () => {
          try {
            const out = await api.post(`/rewards/${reward.id}/redeem`, {}, { 'Idempotency-Key': idemKey() });
            updateBalance(out.balance); dlg.close(); showRedeemed(out.redemption); if (state.route.name === 'rewards') route();
          } catch (er) { toast(er.message, 'error'); if (['OUT_OF_STOCK', 'INSUFFICIENT_COINS', 'REWARD_UNAVAILABLE'].includes(er.code)) { dlg.close(); if (state.route.name === 'rewards') route(); } }
        });
      });
    });
    return d;
  }

  const voucherBox = (code) => html`<div class="voucher"><code id="vc">${code}</code><button class="btn btn-sm" data-action="copy" data-text="${code}">Copy</button></div>`;

  function showRedeemed(r) {
    modal('🎉 Redeemed!', html`<p><b>${r.rewardName}</b> is yours. Balance updated.</p>
      ${r.voucherCode ? html`<p class="muted small">Your voucher code (only you can see this):</p>${voucherBox(r.voucherCode)}` : ''}
      ${r.redemptionDetails ? html`<h3>How to use it</h3><p class="muted">${r.redemptionDetails}</p>` : ''}
      <div class="row end gap"><a class="btn btn-primary" href="#/redemptions" data-close>My Redemptions</a></div>`);
  }

  // ---- Views -------------------------------------------------------------
  const views = {};

  views.home = async (view, r) => {
    mount(view, skeleton(3));
    const [rewards, txs] = await Promise.all([api.get('/rewards?limit=4'), api.get('/me/transactions?limit=4')]);
    const c = state.config;
    mount(view, html`
      ${r.query.get('welcome') ? html`<div class="banner" role="status">🎉 Welcome! We added ${c.signupBonus} G Coins to your balance.</div>` : ''}
      <section class="hero"><p class="hero-sub">Hi ${state.user.name.split(' ')[0]}, your balance</p>
        <div class="big">${coin} ${num(state.user.balance)}</div><p class="hero-sub2">G Coins</p>
        <div class="row gap wrap"><a class="btn btn-primary" href="#/rewards">Browse rewards</a><a class="btn" href="#/share">Earn ${c.shareBonus} coins</a></div></section>
      <h2>How it works</h2>
      <div class="steps"><div class="card step"><b>1</b>Earn coins: ${c.signupBonus} for joining, ${c.shareBonus} for each reward you share.</div><div class="card step"><b>2</b>Pick a reward you can afford.</div><div class="card step"><b>3</b>Confirm and redeem. Vouchers appear in My Redemptions.</div></div>
      <div class="row between mt-2 mb-1"><h2 class="m0">Featured rewards</h2><a href="#/rewards">See all</a></div>
      ${rewards.items.length ? html`<div class="grid">${rewards.items.map(rewardCard)}</div>` : empty('🎁', 'No rewards yet', 'Check back soon, new rewards are added regularly.')}
      <h2 class="mt-2">Recent activity</h2>
      ${txs.items.length ? html`<div class="list">${txs.items.map(txItem)}</div>` : empty('🪙', 'No activity yet', 'Your bonuses and redemptions will show up here.')}`);
  };

  const txItem = (t) => html`<div class="item"><div class="grow"><div class="t">${t.description}</div><div class="muted small">${fmtDate(t.createdAt)}</div></div><span class="amt ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${num(t.amount)}</span></div>`;

  views.rewards = async (view, r) => {
    const page = Number(r.query.get('page')) || 1; const q = r.query.get('q') || '';
    mount(view, html`<h1>Rewards</h1><form class="toolbar" id="rq" role="search"><input type="search" name="q" placeholder="Search rewards" value="${q}" aria-label="Search rewards" maxlength="60"><button class="btn">Search</button></form><div id="rl">${skeleton(4)}</div>`);
    $('#rq').addEventListener('submit', (e) => { e.preventDefault(); go(`rewards?q=${encodeURIComponent(new FormData(e.target).get('q'))}`); });
    const data = await api.get(`/rewards?page=${page}&limit=12&q=${encodeURIComponent(q)}`);
    mount($('#rl'), data.items.length ? html`<div class="grid">${data.items.map(rewardCard)}</div>${pager(data, 'rpage')}` : empty('🔍', q ? 'No matches' : 'No rewards available', q ? 'Try a different search.' : 'New rewards are coming soon.'));
  };

  views.redemptions = async (view, r) => {
    const page = Number(r.query.get('page')) || 1;
    mount(view, html`<h1>My Redemptions</h1><div id="rl">${skeleton(3)}</div>`);
    const data = await api.get(`/redemptions?page=${page}&limit=10`);
    mount($('#rl'), data.items.length ? html`<div class="list">${data.items.map((x) => html`<div class="item"><img src="${x.imageUrl || '/img/logo.svg'}" alt=""><div class="grow"><div class="t">${x.rewardName}</div><div class="muted small">${fmtDate(x.createdAt)} · ${coin} ${num(x.price)}</div></div><button class="btn btn-sm" data-action="redemption" data-id="${x.id}">${x.hasVoucher ? 'Show code' : 'Details'}</button></div>`)}</div>${pager(data, 'dpage')}`
      : empty('🎟️', 'Nothing redeemed yet', 'Redeem your first reward to see it here.', html`<a class="btn btn-primary" href="#/rewards">Browse rewards</a>`));
  };

  async function openRedemption(id) {
    try {
      const { redemption: x } = await api.get(`/redemptions/${id}`);
      modal(x.rewardName, html`${x.imageUrl ? html`<img class="hero-img" src="${x.imageUrl}" alt="">` : ''}
        <dl class="kv"><dt>Redeemed</dt><dd>${fmtDate(x.completedAt || x.createdAt)}</dd><dt>Cost</dt><dd>${coin} ${num(x.price)}</dd></dl>
        ${x.voucherCode ? html`<p class="muted small">Your voucher code. Keep it private:</p>${voucherBox(x.voucherCode)}` : html`<p class="muted">No voucher code is shown for this reward.</p>`}
        ${x.redemptionDetails ? html`<h3>How to use it</h3><p class="muted">${x.redemptionDetails}</p>` : ''}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  views.share = async (view, r) => {
    const c = state.config;
    mount(view, html`<h1>Share &amp; Earn</h1>
      <div class="card"><h2>The rules</h2><ul class="rules">
        <li>Share a reward and earn <b>${c.shareBonus} G Coins</b>, once per reward.</li>
        <li>${c.share.requireVisit ? 'The bonus is credited automatically after a <b>different person, on a different device</b>, opens your link. Opening it yourself does not count.' : `Create your link, share it, then tap “I shared it”. You can confirm ${c.share.minDelaySeconds} seconds after creating the link.`}</li>
        <li>Up to <b>${c.share.dailyBonusLimit} share bonuses per day</b>.</li>
        <li>Fake or repeated claims are ignored automatically by the server.</li></ul></div>
      <h2 class="mt-15">Choose a reward to share</h2><div id="sl">${skeleton(3)}</div>`);
    const [rewards, shares] = await Promise.all([api.get('/rewards?limit=48'), api.get('/shares')]);
    const byReward = new Map(shares.shares.map((s) => [s.rewardId, s]));
    mount($('#sl'), rewards.items.length ? html`<div class="list">${rewards.items.map((rw) => {
      const s = byReward.get(rw.id);
      const status = !s ? ['Not shared yet', ''] : s.status === 'credited' ? [`+${c.shareBonus} earned`, 'ok'] : s.status === 'qualified' ? ['Daily limit reached, retry tomorrow', 'warn'] : [c.share.requireVisit ? 'Waiting for a friend to open it' : 'Link created', 'info'];
      return html`<div class="item"><img src="${rw.imageUrl || '/img/logo.svg'}" alt=""><div class="grow"><div class="t">${rw.name}</div><span class="chip ${status[1]}">${status[0]}</span></div>
        <button class="btn btn-sm ${s && s.status === 'credited' ? '' : 'btn-primary'}" data-action="share" data-id="${rw.id}" ${s && s.status === 'credited' ? '' : ''}>${s ? 'Open' : 'Share'}</button></div>`;
    })}</div>` : empty('🔗', 'Nothing to share yet', 'Rewards will appear here once they are available.'));
    const pre = r.query.get('reward'); if (pre) openShare(pre);
  };

  async function openShare(rewardId) {
    let share;
    try { share = (await api.post('/shares', { rewardId })).share; } catch (e) { return toast(e.message, 'error'); }
    const c = state.config;
    modal('Share this reward', html`<p class="muted">Your personal link:</p>
      <div class="voucher"><code>${share.url}</code><button class="btn btn-sm" data-action="copy" data-text="${share.url}">Copy</button></div>
      <p class="muted small" id="ss">${share.status === 'credited' ? `Bonus earned: +${c.shareBonus} G Coins 🎉` : c.share.requireVisit ? 'Bonus is credited when a friend opens the link on their own device.' : 'Share the link, then confirm below.'}</p>
      <div class="row gap wrap">${navigator.share ? html`<button class="btn btn-primary" data-act="native">Share…</button>` : ''}
        ${share.status !== 'credited' ? html`<button class="btn ${navigator.share ? '' : 'btn-primary'}" data-act="check">${c.share.requireVisit ? 'Check status' : 'I shared it'}</button>` : ''}</div>`, (dlg) => {
      const nat = $('[data-act=native]', dlg);
      if (nat) nat.addEventListener('click', async () => { try { await navigator.share({ title: 'G Coin Rewards', text: 'Check out this reward on G Coin Rewards', url: share.url }); } catch { /* cancelled */ } });
      const chk = $('[data-act=check]', dlg);
      if (chk) chk.addEventListener('click', async () => {
        await withBusy(chk, async () => {
          try {
            const out = await api.post(`/shares/${share.id}/${share.status === 'qualified' ? 'claim' : 'confirm'}`);
            share = out.share; updateBalance(out.balance);
            if (out.share.status === 'credited') { toast(`+${c.shareBonus} G Coins earned!`, 'success'); dlg.close(); if (state.route.name === 'share') route(); }
            else toast(c.share.requireVisit ? 'Not credited yet. A friend needs to open your link first.' : 'Not credited yet.', 'info');
          } catch (er) { toast(er.message, 'error'); }
        });
      });
    });
  }

  views.profile = async (view, r) => {
    const page = Number(r.query.get('page')) || 1;
    mount(view, html`<h1>Profile</h1>
      <div class="card row gap">${state.user.picture ? html`<img src="${state.user.picture}" alt="" width="64" height="64" referrerpolicy="no-referrer" class="avatar">` : html`<span class="coin coin-xl">${state.user.name[0]}</span>`}
        <div class="grow"><h2 class="m0">${state.user.name}</h2><div class="muted wrap-any">${state.user.email}</div><div class="muted small">Member since ${fmtDay(state.user.createdAt)}</div></div></div>
      <div class="card mt-1"><div class="muted">Current balance</div><div class="price price-xl">${coin} ${num(state.user.balance)} G Coins</div></div>
      <h2 class="mt-15">Transaction history</h2><div id="tl">${skeleton(3)}</div>
      <div class="row mt-2"><button class="btn" data-action="logout">Sign out</button></div>`);
    const data = await api.get(`/me/transactions?page=${page}&limit=15`);
    mount($('#tl'), data.items.length ? html`<div class="list">${data.items.map(txItem)}</div>${pager(data, 'tpage')}` : empty('🪙', 'No transactions yet', 'Bonuses and redemptions will appear here.'));
  };

  // ---- Chatbot ------------------------------------------------------------
  function renderChat() {
    mount($('#chat-root'), html`<button class="chat-fab" id="chat-open" aria-label="Open G Coin assistant" aria-expanded="false">💬</button>
      <section class="chat" id="chat" role="dialog" aria-label="G Coin assistant" hidden>
        <div class="chat-head"><span aria-hidden="true">🤖</span><b>G Coin Assistant</b><button class="icon-btn" id="chat-close" aria-label="Close assistant">&times;</button></div>
        <div class="chat-log" id="chat-log" aria-live="polite"></div>
        <p class="chat-note">AI-generated answers can be wrong. The assistant can’t redeem rewards, change balances or show voucher codes. Please don’t share passwords or private details.</p>
        <form class="chat-form" id="chat-form"><input id="chat-in" name="m" autocomplete="off" maxlength="${state.config.chatMaxChars}" placeholder="Ask about G Coins…" aria-label="Your question" required><button class="btn btn-primary" type="submit">Send</button></form>
      </section>`);
    const log = $('#chat-log');
    const add = (cls, text, tag) => { const m = document.createElement('div'); m.className = `msg ${cls}`; if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; m.appendChild(t); } m.appendChild(document.createTextNode(text)); log.appendChild(m); log.scrollTop = log.scrollHeight; return m; };
    const greet = () => {
      add('bot', 'Hi! I can explain G Coins, reward prices and availability, sharing, redemptions and vouchers.', 'AI assistant');
      const s = document.createElement('div'); s.className = 'suggest';
      ['How do I earn coins?', 'Which rewards can I afford?', 'What is my balance?', 'How do vouchers work?'].forEach((q) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = q; b.addEventListener('click', () => { s.remove(); send(q); }); s.appendChild(b); });
      log.appendChild(s);
    };
    const toggle = (open) => { $('#chat').hidden = !open; $('#chat-open').setAttribute('aria-expanded', String(open)); $('#chat-open').hidden = open && window.innerWidth < 760; if (open) { if (!log.children.length) greet(); $('#chat-in').focus(); } };
    $('#chat-open').addEventListener('click', () => toggle(true));
    $('#chat-close').addEventListener('click', () => { toggle(false); $('#chat-open').hidden = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chat').hidden) { toggle(false); $('#chat-open').hidden = false; } });
    async function send(text) {
      add('user', text);
      const wait = document.createElement('div'); wait.className = 'msg bot'; wait.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; log.appendChild(wait); log.scrollTop = log.scrollHeight;
      try {
        const out = await api.post('/chat', { message: text, history: state.chat.history.slice(-6) });
        wait.remove(); add('bot', out.reply, out.source === 'ai' ? 'AI-generated' : out.source === 'fallback' ? 'Automated answer (AI unavailable)' : 'Assistant');
        state.chat.history.push({ role: 'user', content: text }, { role: 'assistant', content: out.reply });
      } catch (e) { wait.remove(); add('bot', e.status === 429 ? e.message : 'Sorry, I could not answer just now. Please try again in a moment.', 'Assistant'); }
    }
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#chat-in'); const v = i.value.trim(); if (!v) return; i.value = ''; send(v); });
  }

  // ---- Global actions (CSP-safe event delegation) --------------------------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]'); if (!t) return;
    const a = t.dataset.action;
    if (a === 'reward') openReward(t.dataset.id);
    else if (a === 'redemption') openRedemption(t.dataset.id);
    else if (a === 'share') openShare(t.dataset.id);
    else if (a === 'retry') route();
    else if (a === 'copy') { try { await navigator.clipboard.writeText(t.dataset.text); toast('Copied', 'success'); } catch { toast('Copy failed. Select the text and copy it manually.', 'error'); } }
    else if (['rpage', 'dpage', 'tpage'].includes(a)) { const q = new URLSearchParams(state.route.query); q.set('page', t.dataset.page); go(`${state.route.name}?${q}`); }
    else if (a === 'logout') { try { await api.post('/auth/logout'); } catch { /* ignore */ } state.user = null; await state.refresh(); app.textContent = ''; go('login'); route(); }
  });

  // ---- Boot ---------------------------------------------------------------
  (async function boot() {
    try {
      state.config = await rawApi.get('/config');
      await state.refresh();
      document.title = state.config.appName;
      window.addEventListener('hashchange', route);
      route();
    } catch (err) {
      mount(app, html`<main class="login">${errorBox('We could not reach the server. Please check your connection.')}</main>`);
      app.addEventListener('click', (e) => { if (e.target.closest('[data-action=retry]')) location.reload(); });
    }
  })();
})();
