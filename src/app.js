'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { config } = require('./config');
const logger = require('./lib/logger');
const { securityHeaders, noStore, originCheck, csrfProtection } = require('./middleware/security');
const { userSession, adminSession } = require('./middleware/session');
const { notFound, errorHandler } = require('./middleware/error');
const limiter = require('./middleware/rateLimit');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple'); // no nested objects/operators in query strings

  app.use((req, res, next) => {
    req.id = crypto.randomBytes(6).toString('hex');
    res.set('X-Request-Id', req.id);
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) logger.info('req', { id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  app.use(securityHeaders());
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));

  app.use('/api/admin', express.json({ limit: '400kb' })); // bulk voucher uploads
  app.use(express.json({ limit: '20kb' }));

  const user = userSession();
  const admin = adminSession();
  // Customer sessions never run for admin routes, and the admin cookie is path-scoped to /api/admin.
  app.use((req, res, next) => (req.path.startsWith('/api/admin') ? next() : user(req, res, next)));
  app.use('/api/admin', admin);

  app.use('/api', noStore, limiter.api, originCheck);
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', (req, res, next) => (req.path.startsWith('/admin') ? next() : csrfProtection(req, res, next)));

  app.use(require('./routes/public'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api', require('./routes/user'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
