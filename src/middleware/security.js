'use strict';

const helmet = require('helmet');
const { config } = require('../config');
const { AppError } = require('../lib/errors');
const { safeEqual, randomToken } = require('../lib/crypto');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// Reject cross-origin state-changing requests. Browsers always send Origin on these.
function originCheck(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !config.allowedOrigins.includes(origin)) {
    return next(new AppError(403, 'BAD_ORIGIN', 'Cross-origin request blocked'));
  }
  return next();
}

// Synchronizer-token CSRF protection bound to the session. The token is handed out by the
// session endpoints and must be echoed back in the X-CSRF-Token header.
function ensureCsrfToken(req) {
  if (!req.session.csrf) req.session.csrf = randomToken(32);
  return req.session.csrf;
}

function csrfProtection(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const expected = req.session && req.session.csrf;
  const got = req.get('x-csrf-token');
  if (!expected || !got || !safeEqual(expected, got)) {
    return next(new AppError(403, 'CSRF', 'Missing or invalid CSRF token. Reload the page and try again.'));
  }
  return next();
}

module.exports = { securityHeaders, noStore, originCheck, csrfProtection, ensureCsrfToken };
