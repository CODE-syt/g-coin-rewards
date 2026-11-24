'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { config } = require('../config');
const { APP_NAME, SIGNUP_BONUS, SHARE_BONUS } = require('../constants');
const { asyncHandler } = require('../lib/errors');
const { ensureCsrfToken } = require('../middleware/security');
const { optionalUser } = require('../middleware/auth');
const limiter = require('../middleware/rateLimit');
const { toUserDto } = require('../services/userAuth');
const { recordVisit } = require('../services/shares');
const { getPublicReward } = require('../services/rewards');

const router = express.Router();

router.get('/api/health', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' });
});

router.get('/api/config', (req, res) => {
  res.json({
    appName: APP_NAME,
    signupBonus: SIGNUP_BONUS,
    shareBonus: SHARE_BONUS,
    googleEnabled: config.google.enabled,
    devLoginEnabled: config.enableDevLogin,
    chatbotEnabled: config.chatbot.enabled,
    chatMaxChars: config.chatbot.maxInputChars,
    share: {
      requireVisit: config.share.requireVisit,
      dailyBonusLimit: config.share.dailyBonusLimit,
      minDelaySeconds: config.share.minDelaySeconds,
    },
  });
});

// Boot call for the SPA: tells it who is signed in and hands out the CSRF token.
router.get('/api/session', optionalUser, (req, res) => {
  res.json({ user: req.user ? toUserDto(req.user) : null, csrfToken: ensureCsrfToken(req) });
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const absolute = (u) => (u && u.startsWith('/') ? config.publicUrl + u : u || '');

function landingPage({ title, description, image, price, link }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${esc(APP_NAME)}</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(absolute(image))}">` : ''}
<meta property="og:type" content="website">
<link rel="stylesheet" href="/css/styles.css">
</head><body class="landing">
<main class="landing-card">
${image ? `<img class="landing-img" src="${esc(image)}" alt="">` : ''}
<p class="eyebrow">${esc(APP_NAME)}</p>
<h1>${esc(title)}</h1>
<p>${esc(description)}</p>
${price ? `<p class="price-chip"><span class="coin" aria-hidden="true">G</span> ${esc(price)} G Coins</p>` : ''}
<a class="btn btn-primary" href="${esc(link)}">Open ${esc(APP_NAME)}</a>
<p class="muted small">Sign in with Google to earn ${SIGNUP_BONUS} G Coins and redeem rewards.</p>
</main></body></html>`;
}

// Public share link. Records a (possibly qualifying) visit, then shows a safe preview of the reward.
router.get('/r/:token', limiter.landing, optionalUser, asyncHandler(async (req, res) => {
  const share = await recordVisit(req.params.token, { ip: req.ip, ua: req.get('user-agent'), viewerUserId: req.user && req.user._id });
  res.set('Cache-Control', 'no-store');
  const reward = share ? await getPublicReward(share.rewardId) : null;
  if (!reward) {
    return res.status(404).type('html').send(landingPage({ title: 'Link not available', description: 'This share link is no longer active.', link: '/' }));
  }
  return res.type('html').send(
    landingPage({ title: reward.name, description: reward.description.slice(0, 240), image: reward.imageUrl, price: reward.price, link: `/#/rewards/${reward.id}` })
  );
}));

module.exports = router;
