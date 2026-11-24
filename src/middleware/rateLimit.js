'use strict';

const rateLimit = require('express-rate-limit');
const { config } = require('../config');

const passthrough = (req, res, next) => next();

function make({ windowMs, max, message, keyGenerator }) {
  if (!config.security.rateLimitEnabled) return passthrough;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
  });
}

const byUserOrIp = (req) => (req.session && req.session.userId ? `u:${req.session.userId}` : `ip:${req.ip}`);

module.exports = {
  api: make({ windowMs: 60_000, max: 300, message: 'Too many requests. Please slow down.' }),
  auth: make({ windowMs: 10 * 60_000, max: 30, message: 'Too many sign-in attempts. Try again later.' }),
  adminLogin: make({ windowMs: 15 * 60_000, max: 20, message: 'Too many login attempts. Try again later.' }),
  redeem: make({ windowMs: 60_000, max: 20, message: 'Too many redemption attempts. Please wait a moment.', keyGenerator: byUserOrIp }),
  share: make({ windowMs: 60_000, max: 30, message: 'Too many share actions. Please wait a moment.', keyGenerator: byUserOrIp }),
  chat: make({ windowMs: 60_000, max: config.chatbot.ratePerMinute, message: 'You are sending messages too quickly. Please wait a moment.', keyGenerator: byUserOrIp }),
  landing: make({ windowMs: 60_000, max: 120, message: 'Too many requests.' }),
};
