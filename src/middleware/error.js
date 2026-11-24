'use strict';

const { ZodError } = require('zod');
const { AppError } = require('../lib/errors');
const logger = require('../lib/logger');

const notFound = (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Not found'));

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: 'Please check your input',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request is too large' } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
  }

  // Unexpected: log details server-side, return nothing internal to the client.
  logger.error('unhandled_error', { requestId: req.id, path: req.path, name: err && err.name, message: err && err.message });
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: req.id } });
}

module.exports = { notFound, errorHandler };
