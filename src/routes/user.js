'use strict';

const express = require('express');
const { config } = require('../config');
const { User, CoinTransaction, Redemption } = require('../models');
const { AppError, asyncHandler } = require('../lib/errors');
const { isId, parsePage, pageResult } = require('../lib/util');
const { requireUser, optionalUser } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const limiter = require('../middleware/rateLimit');
const { toUserDto } = require('../services/userAuth');
const { toTxDto } = require('../services/ledger');
const { listPublicRewards, getPublicReward } = require('../services/rewards');
const { redeemReward, toRedemptionDto, withVoucher } = require('../services/redemptions');
const shares = require('../services/shares');
const chatbot = require('../services/chatbot');
const { shareCreate, chatBody } = require('../schemas');

const router = express.Router();
const str = (v) => (typeof v === 'string' ? v : '');
const idParam = (req) => {
  if (!isId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return req.params.id;
};

// ---- Profile & ledger ------------------------------------------------------
router.get('/me', requireUser, (req, res) => res.json({ user: toUserDto(req.user) }));

router.get('/me/transactions', requireUser, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query, { defaultLimit: 15, maxLimit: 50 });
  const filter = { userId: req.user._id };
  const [items, total] = await Promise.all([
    CoinTransaction.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    CoinTransaction.countDocuments(filter),
  ]);
  res.json(pageResult(items.map(toTxDto), total, pg));
}));

// ---- Rewards ---------------------------------------------------------------
router.get('/rewards', requireUser, asyncHandler(async (req, res) => {
  res.json(await listPublicRewards({ page: req.query.page, limit: req.query.limit, q: str(req.query.q) }));
}));

router.get('/rewards/:id', requireUser, asyncHandler(async (req, res) => {
  const reward = await getPublicReward(idParam(req));
  if (!reward) throw new AppError(404, 'REWARD_NOT_FOUND', 'Reward not found');
  res.json({ reward });
}));

router.post('/rewards/:id/redeem', requireUser, limiter.redeem, asyncHandler(async (req, res) => {
  const result = await redeemReward({ userId: req.user._id, rewardId: idParam(req), idempotencyKey: req.get('idempotency-key') });
  const fresh = await User.findById(req.user._id).select('coinBalance').lean();
  const redemption = await withVoucher(result.redemption, req.user._id);
  res.status(result.replayed ? 200 : 201).json({ redemption, balance: fresh.coinBalance, replayed: result.replayed });
}));

// ---- Redemptions (voucher codes are only ever returned by the detail endpoint, to the owner) ----
router.get('/redemptions', requireUser, asyncHandler(async (req, res) => {
  const pg = parsePage(req.query, { defaultLimit: 10, maxLimit: 30 });
  const filter = { userId: req.user._id, status: 'completed' };
  const [items, total] = await Promise.all([
    Redemption.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    Redemption.countDocuments(filter),
  ]);
  res.json(pageResult(items.map(toRedemptionDto), total, pg));
}));

router.get('/redemptions/:id', requireUser, asyncHandler(async (req, res) => {
  // Scoped by userId: another user's id behaves exactly like a missing one.
  const redemption = await Redemption.findOne({ _id: idParam(req), userId: req.user._id, status: 'completed' });
  if (!redemption) throw new AppError(404, 'NOT_FOUND', 'Redemption not found');
  res.json({ redemption: await withVoucher(redemption, req.user._id) });
}));

// ---- Share & Earn ----------------------------------------------------------
router.get('/shares', requireUser, asyncHandler(async (req, res) => res.json({ shares: await shares.listShares(req.user._id) })));

router.post('/shares', requireUser, limiter.share, validate(shareCreate), asyncHandler(async (req, res) => {
  const share = await shares.createShare(req.user._id, req.valid.body.rewardId, { ip: req.ip, ua: req.get('user-agent'), channel: req.valid.body.channel });
  res.status(201).json({ share: shares.toShareDto(share) });
}));

router.post('/shares/:id/confirm', requireUser, limiter.share, asyncHandler(async (req, res) => {
  const share = await shares.confirmShare(req.user._id, idParam(req));
  const user = await User.findById(req.user._id).select('coinBalance').lean();
  res.json({ share: shares.toShareDto(share), balance: user.coinBalance });
}));

router.post('/shares/:id/claim', requireUser, limiter.share, asyncHandler(async (req, res) => {
  const share = await shares.claimShare(req.user._id, idParam(req));
  const user = await User.findById(req.user._id).select('coinBalance').lean();
  res.json({ share: shares.toShareDto(share), balance: user.coinBalance });
}));

// ---- Chatbot ---------------------------------------------------------------
const dailyUse = new Map(); // `${userId|ip}:${day}` -> count (per instance; fine as a cost guard)
function chargeDaily(key) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${key}:${day}`;
  if (dailyUse.size > 5000) for (const old of dailyUse.keys()) if (!old.endsWith(day)) dailyUse.delete(old);
  const n = (dailyUse.get(k) || 0) + 1;
  dailyUse.set(k, n);
  return n <= config.chatbot.dailyLimitPerUser;
}

router.post('/chat', limiter.chat, optionalUser, asyncHandler(async (req, res, next) => {
  if (!config.chatbot.enabled) throw new AppError(404, 'CHAT_DISABLED', 'The assistant is not available');
  return validate(chatBody(config.chatbot.maxInputChars))(req, res, next);
}), asyncHandler(async (req, res) => {
  if (!chargeDaily(req.user ? `u:${req.user._id}` : `ip:${req.ip}`)) {
    throw new AppError(429, 'DAILY_LIMIT', 'You have reached today\'s assistant limit. Please try again tomorrow.');
  }
  const { message, history } = req.valid.body;
  const out = await chatbot.answer({ message, history, user: req.user });
  res.json({ reply: out.reply, source: out.source, needsSignIn: Boolean(out.needsSignIn) });
}));

module.exports = router;
