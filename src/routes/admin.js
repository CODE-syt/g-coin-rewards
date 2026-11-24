'use strict';

const express = require('express');
const { config } = require('../config');
const { Admin, Reward, VoucherCode, User, CoinTransaction, Redemption, AuditLog } = require('../models');
const { AppError, asyncHandler } = require('../lib/errors');
const { isId, escapeRegex, parsePage, pageResult } = require('../lib/util');
const { randomToken } = require('../lib/crypto');
const { ensureCsrfToken, csrfProtection } = require('../middleware/security');
const { requireAdmin, loadAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { regenerate, save, destroy } = require('../middleware/session');
const limiter = require('../middleware/rateLimit');
const { audit } = require('../services/audit');
const adminAuth = require('../services/adminAuth');
const { normalizeCodes, addCodes, mask } = require('../services/vouchers');
const { toTxDto } = require('../services/ledger');
const { rewardCreate, rewardUpdate, adminLogin, reauth, voucherAdd } = require('../schemas');
const { z } = require('zod');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : '');
const idParam = (req) => {
  if (!isId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return req.params.id;
};

router.use(csrfProtection);

// Enforced on every data route when ADMIN_REQUIRE_MFA=true.
const mfaGate = (req, res, next) => {
  if (config.security.adminRequireMfa && !req.admin.mfaEnabled) {
    return next(new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Set up multi-factor authentication before using the admin panel'));
  }
  return next();
};
const viewer = [requireAdmin('viewer'), mfaGate];
const manager = [requireAdmin('admin'), mfaGate];
const superadmin = [requireAdmin('superadmin'), mfaGate];

// ---- Session & authentication ---------------------------------------------
router.get('/session', loadAdmin, (req, res) => {
  res.json({
    admin: req.admin ? adminAuth.toAdminDto(req.admin) : null,
    csrfToken: ensureCsrfToken(req),
    mfaEnrollmentRequired: Boolean(req.admin && config.security.adminRequireMfa && !req.admin.mfaEnabled),
  });
});

router.post('/login', limiter.adminLogin, validate(adminLogin), asyncHandler(async (req, res) => {
  const admin = await adminAuth.login(req, req.valid.body);
  await regenerate(req);
  req.session.adminId = String(admin._id);
  req.session.adminAuthAt = Date.now();
  req.session.csrf = randomToken(32);
  await save(req);
  await audit(req, 'admin.login', { admin, targetType: 'admin', targetId: admin._id });
  res.json({ admin: adminAuth.toAdminDto(admin), csrfToken: req.session.csrf, mfaEnrollmentRequired: config.security.adminRequireMfa && !admin.mfaEnabled });
}));

router.post('/logout', loadAdmin, asyncHandler(async (req, res) => {
  if (req.admin) await audit(req, 'admin.logout', { targetType: 'admin', targetId: req.admin._id });
  await destroy(req);
  res.clearCookie('gc.admin.sid', { path: '/api/admin' });
  res.json({ ok: true });
}));

// ---- MFA -------------------------------------------------------------------
router.post('/mfa/setup', requireAdmin('viewer'), asyncHandler(async (req, res) => {
  res.json(await adminAuth.beginMfaSetup(req.admin));
}));

router.post('/mfa/enable', requireAdmin('viewer'), validate(z.object({ code: z.string().trim().min(6).max(10) })), asyncHandler(async (req, res) => {
  await adminAuth.finishMfaSetup(req.admin, req.valid.body.code);
  await audit(req, 'admin.mfa_enabled', { targetType: 'admin', targetId: req.admin._id });
  res.json({ ok: true });
}));

router.post('/mfa/disable', requireAdmin('viewer'), validate(reauth), asyncHandler(async (req, res) => {
  if (config.security.adminRequireMfa) throw new AppError(409, 'MFA_REQUIRED', 'MFA is mandatory for this deployment');
  await adminAuth.verifyReauth(req, req.valid.body);
  await Admin.updateOne({ _id: req.admin._id }, { $set: { mfaEnabled: false }, $unset: { mfaSecretEnc: 1, mfaPendingSecretEnc: 1 } });
  await audit(req, 'admin.mfa_disabled', { targetType: 'admin', targetId: req.admin._id });
  res.json({ ok: true });
}));

// ---- Dashboard -------------------------------------------------------------
router.get('/stats', viewer, asyncHandler(async (req, res) => {
  const [users, circulation, spent, redemptions, rewards, vouchers, recent] = await Promise.all([
    User.countDocuments(),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$coinBalance' } } }]),
    CoinTransaction.aggregate([{ $match: { type: 'redemption' } }, { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }]),
    Redemption.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Reward.countDocuments({ deletedAt: null, status: 'active' }),
    VoucherCode.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 86400_000) } }),
  ]);
  const by = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.n]));
  res.json({
    users,
    newUsers7d: recent,
    coinsInCirculation: (circulation[0] && circulation[0].total) || 0,
    coinsSpent: (spent[0] && spent[0].total) || 0,
    activeRewards: rewards,
    redemptions: by(redemptions),
    vouchers: by(vouchers),
  });
}));

// ---- Rewards ---------------------------------------------------------------
async function inventoryFor(ids) {
  const rows = ids.length
    ? await VoucherCode.aggregate([{ $match: { rewardId: { $in: ids } } }, { $group: { _id: { r: '$rewardId', s: '$status' }, n: { $sum: 1 } } }])
    : [];
  const map = new Map();
  for (const row of rows) {
    const k = String(row._id.r);
    map.set(k, { ...(map.get(k) || { available: 0, assigned: 0, redeemed: 0 }), [row._id.s]: row.n });
  }
  return map;
}

const toAdminReward = (r, inv) => ({
  id: String(r._id),
  name: r.name,
  description: r.description,
  imageUrl: r.imageUrl,
  price: r.price,
  status: r.status,
  voucherMode: r.voucherMode,
  stock: r.stock,
  perUserLimit: r.perUserLimit,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  redemptionDetails: r.redemptionDetails,
  sortOrder: r.sortOrder,
  redeemedCount: r.redeemedCount,
  deleted: Boolean(r.deletedAt),
  inventory: inv || { available: 0, assigned: 0, redeemed: 0 },
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function checkWindow(startsAt, endsAt) {
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, 'VALIDATION', 'End date must be after the start date');
}

router.get('/rewards', viewer, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};
  if (str(req.query.deleted) !== 'true') filter.deletedAt = null;
  if (['active', 'inactive'].includes(str(req.query.status))) filter.status = req.query.status;
  if (str(req.query.q)) filter.name = { $regex: escapeRegex(str(req.query.q).slice(0, 60)), $options: 'i' };
  const [rewards, total] = await Promise.all([
    Reward.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    Reward.countDocuments(filter),
  ]);
  const inv = await inventoryFor(rewards.map((r) => r._id));
  res.json(pageResult(rewards.map((r) => toAdminReward(r, inv.get(String(r._id)))), total, pg));
}));

router.get('/rewards/:id', viewer, asyncHandler(async (req, res) => {
  const r = await Reward.findById(idParam(req)).lean();
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Reward not found');
  const inv = await inventoryFor([r._id]);
  res.json({ reward: toAdminReward(r, inv.get(String(r._id))) });
}));

router.post('/rewards', manager, validate(rewardCreate), asyncHandler(async (req, res) => {
  const input = req.valid.body;
  checkWindow(input.startsAt, input.endsAt);
  const voucherMode = input.voucherMode || 'none';
  const reward = await Reward.create({
    ...input,
    voucherMode,
    stock: voucherMode === 'none' ? input.stock ?? null : null,
    status: input.status || 'inactive',
  });
  await audit(req, 'reward.create', { targetType: 'reward', targetId: reward._id, details: { name: reward.name, price: reward.price, voucherMode } });
  res.status(201).json({ reward: toAdminReward(reward.toObject()) });
}));

router.patch('/rewards/:id', manager, validate(rewardUpdate), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const existing = await Reward.findOne({ _id: id, deletedAt: null }).lean();
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Reward not found');
  const changes = { ...req.valid.body };
  if (!Object.keys(changes).length) throw new AppError(400, 'VALIDATION', 'Nothing to update');
  const merged = { ...existing, ...changes };
  checkWindow(merged.startsAt, merged.endsAt);
  if (merged.voucherMode !== 'none') changes.stock = null;
  const updated = await Reward.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: changes }, { new: true, runValidators: true }).lean();
  const details = { fields: Object.keys(changes).join(',') };
  if (changes.price !== undefined && changes.price !== existing.price) Object.assign(details, { oldPrice: existing.price, newPrice: changes.price });
  if (changes.status !== undefined && changes.status !== existing.status) Object.assign(details, { oldStatus: existing.status, newStatus: changes.status });
  await audit(req, 'reward.update', { targetType: 'reward', targetId: id, details });
  const inv = await inventoryFor([updated._id]);
  res.json({ reward: toAdminReward(updated, inv.get(String(updated._id))) });
}));

// Sensitive: superadmin only + password (and MFA code) re-entry. Soft delete keeps redemption history intact.
router.delete('/rewards/:id', superadmin, validate(reauth), asyncHandler(async (req, res) => {
  const id = idParam(req);
  await adminAuth.verifyReauth(req, req.valid.body);
  const removed = await Reward.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date(), status: 'inactive' } }, { new: true }).lean();
  if (!removed) throw new AppError(404, 'NOT_FOUND', 'Reward not found');
  await audit(req, 'reward.delete', { targetType: 'reward', targetId: id, details: { name: removed.name } });
  res.json({ ok: true });
}));

// ---- Voucher codes ---------------------------------------------------------
router.get('/rewards/:id/vouchers', viewer, asyncHandler(async (req, res) => {
  const rewardId = idParam(req);
  const pg = parsePage(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filter = { rewardId };
  if (['available', 'assigned', 'redeemed'].includes(str(req.query.status))) filter.status = req.query.status;
  const [items, total] = await Promise.all([
    VoucherCode.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('assignedTo', 'email').lean(),
    VoucherCode.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((v) => ({
    id: String(v._id),
    maskedCode: mask(v), // plaintext codes are never returned to the admin UI
    status: v.status,
    assignedTo: v.assignedTo ? v.assignedTo.email : null,
    assignedAt: v.assignedAt,
    redeemedAt: v.redeemedAt,
    createdAt: v.createdAt,
  })), total, pg));
}));

router.post('/rewards/:id/vouchers', manager, validate(voucherAdd), asyncHandler(async (req, res) => {
  const rewardId = idParam(req);
  const reward = await Reward.findOne({ _id: rewardId, deletedAt: null }).lean();
  if (!reward) throw new AppError(404, 'NOT_FOUND', 'Reward not found');
  if (reward.voucherMode === 'none') throw new AppError(409, 'NO_VOUCHERS', 'This reward does not use voucher codes. Change its voucher mode first.');
  const { valid, invalid, duplicatesInInput } = normalizeCodes(req.valid.body.codes);
  const { added, duplicatesInDb } = valid.length ? await addCodes(rewardId, valid, req.admin._id) : { added: 0, duplicatesInDb: 0 };
  await audit(req, 'voucher.add', { targetType: 'reward', targetId: rewardId, details: { added, invalid, duplicates: duplicatesInInput + duplicatesInDb } });
  res.status(201).json({ added, invalid, duplicates: duplicatesInInput + duplicatesInDb });
}));

// Sensitive: only unassigned codes can be removed; superadmin + re-entry required.
router.delete('/vouchers/:id', superadmin, validate(reauth), asyncHandler(async (req, res) => {
  const id = idParam(req);
  await adminAuth.verifyReauth(req, req.valid.body);
  const removed = await VoucherCode.findOneAndDelete({ _id: id, status: 'available' }).lean();
  if (!removed) throw new AppError(409, 'NOT_DELETABLE', 'Only available (unassigned) codes can be deleted');
  await audit(req, 'voucher.delete', { targetType: 'voucher', targetId: id, details: { rewardId: String(removed.rewardId), last4: removed.last4 } });
  res.json({ ok: true });
}));

// ---- Read-only views -------------------------------------------------------
router.get('/users', viewer, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query);
  const filter = {};
  if (str(req.query.q)) {
    const rx = { $regex: escapeRegex(str(req.query.q).slice(0, 60)), $options: 'i' };
    filter.$or = [{ email: rx }, { name: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    User.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((u) => ({ id: String(u._id), name: u.name, email: u.email, balance: u.coinBalance, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt })), total, pg));
}));

router.get('/transactions', viewer, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query);
  const filter = {};
  if (['signup_bonus', 'share_bonus', 'redemption'].includes(str(req.query.type))) filter.type = req.query.type;
  if (isId(str(req.query.userId))) filter.userId = req.query.userId;
  const [items, total] = await Promise.all([
    CoinTransaction.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('userId', 'email name').lean(),
    CoinTransaction.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((t) => ({ ...toTxDto(t), user: t.userId ? { id: String(t.userId._id), email: t.userId.email } : null })), total, pg));
}));

router.get('/redemptions', viewer, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query);
  const filter = {};
  if (['pending', 'completed', 'failed'].includes(str(req.query.status))) filter.status = req.query.status;
  if (isId(str(req.query.rewardId))) filter.rewardId = req.query.rewardId;
  const [items, total] = await Promise.all([
    Redemption.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('userId', 'email name').populate('voucherCodeId', 'last4 status').lean(),
    Redemption.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((r) => ({
    id: String(r._id),
    status: r.status,
    failCode: r.failCode || null,
    reward: r.rewardSnapshot && r.rewardSnapshot.name,
    price: r.price,
    user: r.userId ? { id: String(r.userId._id), email: r.userId.email } : null,
    voucher: r.voucherCodeId ? { maskedCode: `••••${r.voucherCodeId.last4}`, status: r.voucherCodeId.status } : null,
    createdAt: r.createdAt,
  })), total, pg));
}));

router.get('/inventory', viewer, asyncHandler(async (req, res) => {
  const rewards = await Reward.find({ deletedAt: null }).sort({ sortOrder: 1, createdAt: -1 }).limit(500).lean();
  const inv = await inventoryFor(rewards.map((r) => r._id));
  res.json({
    items: rewards.map((r) => ({
      id: String(r._id),
      name: r.name,
      status: r.status,
      voucherMode: r.voucherMode,
      stock: r.stock,
      redeemedCount: r.redeemedCount,
      inventory: inv.get(String(r._id)) || { available: 0, assigned: 0, redeemed: 0 },
    })),
  });
}));

router.get('/audit', viewer, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query, { defaultLimit: 30, maxLimit: 100 });
  const filter = {};
  if (/^[a-z_.]{3,40}$/.test(str(req.query.action))) filter.action = req.query.action;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json(pageResult(items.map((a) => ({ id: String(a._id), at: a.createdAt, admin: a.adminEmail, action: a.action, targetType: a.targetType, targetId: a.targetId, details: a.details, ip: a.ip })), total, pg));
}));

module.exports = router;
