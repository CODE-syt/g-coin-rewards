'use strict';

const { config } = require('../config');

function log(level, msg, meta) {
  if (config.isTest) return;
  const line = { t: new Date().toISOString(), level, msg, ...meta };
  (level === 'error' ? console.error : console.log)(config.isProd ? JSON.stringify(line) : `${line.t} ${level.toUpperCase()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`);
}

module.exports = {
  info: (m, x) => log('info', m, x),
  warn: (m, x) => log('warn', m, x),
  error: (m, x) => log('error', m, x),
};
