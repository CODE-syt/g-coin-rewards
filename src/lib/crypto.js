'use strict';

const crypto = require('crypto');
const { config } = require('../config');

// One master key in the environment; purpose-specific subkeys are derived with HKDF so that
// a key used for voucher encryption is never reused for hashing or MFA secrets.
const subkeyCache = new Map();
function subkey(purpose) {
  if (!subkeyCache.has(purpose)) {
    subkeyCache.set(purpose, Buffer.from(crypto.hkdfSync('sha256', config.security.dataKey, Buffer.alloc(0), `gcoin:${purpose}`, 32)));
  }
  return subkeyCache.get(purpose);
}

function encrypt(plain, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey(purpose), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function decrypt(blob, purpose) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey(purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

const hmac = (value, purpose) => crypto.createHmac('sha256', subkey(purpose)).update(String(value)).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { encrypt, decrypt, hmac, randomToken, safeEqual };
