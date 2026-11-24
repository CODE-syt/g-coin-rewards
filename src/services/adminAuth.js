'use strict';

const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { Admin } = require('../models');
const { config } = require('../config');
const { AppError } = require('../lib/errors');
const { encrypt, decrypt } = require('../lib/crypto');
const totp = require('../lib/totp');
const { audit } = require('./audit');

const BCRYPT_COST = 12;
// Used to keep response time similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 128) return 'Password must be at most 128 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Use at least 3 of: lowercase, uppercase, digits, symbols';
  if (/^(password|123456|qwerty|letmein|admin)/i.test(pw)) return 'That password is too common';
  return null;
}

const toAdminDto = (a) => ({ id: String(a._id), email: a.email, name: a.name, role: a.role, mfaEnabled: a.mfaEnabled });

async function registerFailure(admin) {
  const upd = await Admin.findOneAndUpdate({ _id: admin._id }, { $inc: { failedLogins: 1 } }, { new: true });
  if (upd && upd.failedLogins >= config.security.adminMaxFailedLogins) {
    await Admin.updateOne({ _id: admin._id }, { $set: { failedLogins: 0, lockUntil: new Date(Date.now() + config.security.adminLockMinutes * 60_000) } });
  }
}

const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email, password or code');

async function login(req, { email, password, code }) {
  const admin = await Admin.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash +mfaSecretEnc');
  if (!admin || admin.disabled) {
    await bcrypt.compare(password, DUMMY_HASH);
    await audit(req, 'admin.login_failed', { details: { reason: 'unknown_or_disabled' } });
    throw invalid();
  }
  if (admin.lockUntil && admin.lockUntil > new Date()) {
    throw new AppError(429, 'LOCKED', 'Too many failed attempts. Try again later.');
  }

  const passwordOk = await bcrypt.compare(password, admin.passwordHash);
  if (!passwordOk) {
    await registerFailure(admin);
    await audit(req, 'admin.login_failed', { admin, details: { reason: 'bad_password' } });
    throw invalid();
  }

  if (admin.mfaEnabled) {
    if (!code) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
    const step = totp.verifyTotp(decrypt(admin.mfaSecretEnc, 'mfa'), code);
    // Atomic replay guard: a given time-step can be accepted only once.
    const fresh = step !== null && (await Admin.updateOne({ _id: admin._id, mfaLastStep: { $lt: step } }, { $set: { mfaLastStep: step } })).modifiedCount === 1;
    if (!fresh) {
      await registerFailure(admin);
      await audit(req, 'admin.login_failed', { admin, details: { reason: 'bad_mfa' } });
      throw invalid();
    }
  }

  await Admin.updateOne({ _id: admin._id }, { $set: { failedLogins: 0, lastLoginAt: new Date() }, $unset: { lockUntil: 1 } });
  return admin;
}

// Sensitive actions require the admin to prove it is still them: password (+ MFA code if enrolled).
async function verifyReauth(req, { confirmPassword, confirmCode }) {
  const admin = await Admin.findById(req.admin._id).select('+passwordHash +mfaSecretEnc');
  const fail = async () => {
    await registerFailure(admin);
    await audit(req, 'admin.reauth_failed', { details: { path: req.originalUrl.slice(0, 120) } });
    throw new AppError(403, 'REAUTH_FAILED', 'Confirmation failed. Check your password' + (admin.mfaEnabled ? ' and authenticator code.' : '.'));
  };
  if (admin.lockUntil && admin.lockUntil > new Date()) throw new AppError(429, 'LOCKED', 'Too many failed attempts. Try again later.');
  if (!confirmPassword || !(await bcrypt.compare(confirmPassword, admin.passwordHash))) return fail();
  if (admin.mfaEnabled && totp.verifyTotp(decrypt(admin.mfaSecretEnc, 'mfa'), confirmCode) === null) return fail();
  return true;
}

async function beginMfaSetup(admin) {
  if (admin.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled');
  const secret = totp.generateSecret();
  await Admin.updateOne({ _id: admin._id }, { $set: { mfaPendingSecretEnc: encrypt(secret, 'mfa') } });
  const url = totp.otpauthUrl({ secret, account: admin.email, issuer: 'G Coin Rewards' });
  return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
}

async function finishMfaSetup(admin, code) {
  const full = await Admin.findById(admin._id).select('+mfaPendingSecretEnc');
  if (!full.mfaPendingSecretEnc) throw new AppError(400, 'NO_PENDING_MFA', 'Start MFA setup first');
  const secret = decrypt(full.mfaPendingSecretEnc, 'mfa');
  const step = totp.verifyTotp(secret, code);
  if (step === null) throw new AppError(400, 'BAD_CODE', 'That code is not valid. Check the time on your phone and try again.');
  await Admin.updateOne(
    { _id: admin._id },
    { $set: { mfaEnabled: true, mfaSecretEnc: full.mfaPendingSecretEnc, mfaLastStep: step }, $unset: { mfaPendingSecretEnc: 1 } }
  );
}

module.exports = { login, verifyReauth, hashPassword, passwordProblem, toAdminDto, beginMfaSetup, finishMfaSetup };
