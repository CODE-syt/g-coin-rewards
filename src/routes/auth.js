'use strict';

const crypto = require('crypto');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { config } = require('../config');
const { asyncHandler, AppError } = require('../lib/errors');
const { randomToken, safeEqual } = require('../lib/crypto');
const logger = require('../lib/logger');
const limiter = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { regenerate, save, destroy } = require('../middleware/session');
const { signInWithGoogleProfile, toUserDto } = require('../services/userAuth');
const { devLogin } = require('../schemas');

const router = express.Router();

const googleClient = () => new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);

async function startSession(req, user) {
  await regenerate(req); // new session id on login prevents session fixation
  req.session.userId = String(user._id);
  req.session.csrf = randomToken(32);
  await save(req);
}

// Step 1: send the browser to Google. `state` (CSRF for the OAuth flow) and a PKCE verifier live in the session.
router.get('/google', limiter.auth, (req, res, next) => {
  if (!config.google.enabled) return res.redirect('/#/login?error=google_not_configured');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.oauth = { state, verifier, at: Date.now() };
  const url = googleClient().generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    access_type: 'online',
  });
  return req.session.save((err) => (err ? next(err) : res.redirect(url)));
});

// Step 2: Google redirects back. We validate state, exchange the code (with the PKCE verifier),
// verify the ID token's signature/audience, and require a verified email. No password is ever involved.
router.get('/google/callback', limiter.auth, asyncHandler(async (req, res) => {
  const fail = (reason) => res.redirect(`/#/login?error=${reason}`);
  const { state, code, error } = req.query;
  const saved = req.session && req.session.oauth;
  if (req.session) delete req.session.oauth;

  if (error) return fail('access_denied');
  if (!saved || typeof state !== 'string' || typeof code !== 'string' || !safeEqual(saved.state, state) || Date.now() - saved.at > 10 * 60_000) {
    return fail('invalid_state');
  }

  let payload;
  try {
    const client = googleClient();
    const { tokens } = await client.getToken({ code, codeVerifier: saved.verifier });
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn('google_oauth_failed', { message: err.message });
    return fail('google_failed');
  }
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) return fail('email_not_verified');

  const { user, isNew } = await signInWithGoogleProfile({ sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture });
  await startSession(req, user);
  return res.redirect(isNew ? '/#/home?welcome=1' : '/#/home');
}));

// Local-development convenience only. Not mounted in production (config refuses to enable it there).
if (config.enableDevLogin) {
  router.post('/dev-login', limiter.auth, validate(devLogin), asyncHandler(async (req, res) => {
    const { email, name } = req.valid.body;
    const { user, isNew, bonusGranted } = await signInWithGoogleProfile({ sub: `dev:${email.toLowerCase()}`, email, name: name || email.split('@')[0], picture: '' });
    await startSession(req, user);
    res.json({ user: toUserDto(user), isNew, bonusGranted, csrfToken: req.session.csrf });
  }));
}

router.post('/logout', asyncHandler(async (req, res) => {
  await destroy(req);
  res.clearCookie('gc.sid', { path: '/' });
  res.json({ ok: true });
}));

module.exports = router;
