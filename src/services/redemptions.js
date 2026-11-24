'use strict';

/**
 * Redemption = a small saga built from single-document atomic updates, so it is correct on a
 * standalone MongoDB as well as on replica sets / Atlas (no multi-document transactions needed).
 *
 *   1. Insert a `pending` Redemption (unique on userId+idempotencyKey)  -> idempotency gate
 *   2. Reserve per-user limit slot       (atomic counter with $lt filter)
 *   3. Debit coins                        (findOneAndUpdate with coinBalance >= price)
 *   4. Reserve stock OR assign voucher    (findOneAndUpdate on status:'available' / stock > 0)
 *   5. Write ledger entry                 (unique idempotency key)
 *   6. Mark voucher redeemed, redemption completed
 *
 * Any failure undoes exactly the steps that were taken (flags are persisted on the redemption so
 * a crashed request can be repaired by reconcile.js). Coins are only ledgered at step 5, after
 * every reservation succeeded, so a failed attempt leaves no ledger noise.
 */

const { User, Reward, VoucherCode, Redemption, RewardUserCount } = require('../models');
const { AppError } = require('../lib/errors');
const { isDupKey } = require('../lib/util');
const logger = require('../lib/logger');
const { recordTx } = require('./ledger');
const { revealCode } = require('./vouchers');

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

async function reserveUserLimit(userId, rewardId, limit) {
  try {
    const doc = await RewardUserCount.findOneAndUpdate(
      { userId, rewardId, count: { $lt: limit } },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    return Boolean(doc);
  } catch (err) {
    if (isDupKey(err)) return false; // counter exists and is at the limit
    throw err;
  }
}

async function markStep(redemptionId, step) {
  await Redemption.updateOne({ _id: redemptionId }, { $set: { [`steps.${step}`]: true } });
}

// Undo whatever the saga managed to do. Safe to call more than once: each undo is guarded
// by the persisted step flag, which is cleared atomically before the undo is applied.
async function compensate(redemptionId) {
  const claim = async (step) => {
    const doc = await Redemption.findOneAndUpdate(
      { _id: redemptionId, [`steps.${step}`]: true },
      { $set: { [`steps.${step}`]: false } },
      { new: false }
    );
    return doc;
  };

  const base = await Redemption.findById(redemptionId).lean();
  if (!base) return;

  if (await claim('voucher')) {
    await VoucherCode.updateOne(
      { redemptionId, status: 'assigned' },
      { $set: { status: 'available' }, $unset: { assignedTo: 1, assignedAt: 1, redemptionId: 1 } }
    );
  }
  if (await claim('stock')) {
    await Reward.updateOne({ _id: base.rewardId, stock: { $type: 'number' } }, { $inc: { stock: 1 } });
  }
  if (await claim('debited')) {
    await User.updateOne({ _id: base.userId }, { $inc: { coinBalance: base.price } });
  }
  if (await claim('limit')) {
    await RewardUserCount.updateOne({ userId: base.userId, rewardId: base.rewardId, count: { $gt: 0 } }, { $inc: { count: -1 } });
  }
}

async function failRedemption(redemptionId, failCode) {
  await compensate(redemptionId);
  await Redemption.updateOne(
    { _id: redemptionId, status: 'pending' },
    { $set: { status: 'failed', failCode, failedAt: new Date() } }
  );
}

const FAIL_MESSAGES = {
  INSUFFICIENT_COINS: 'You do not have enough G Coins for this reward.',
  OUT_OF_STOCK: 'Sorry, this reward just ran out of stock.',
  LIMIT_REACHED: 'You have reached the redemption limit for this reward.',
  REWARD_UNAVAILABLE: 'This reward is not available right now.',
};

async function redeemReward({ userId, rewardId, idempotencyKey }) {
  if (!KEY_RE.test(String(idempotencyKey || ''))) {
    throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'A valid Idempotency-Key header (8-100 chars: letters, digits, _ or -) is required');
  }

  const now = new Date();
  const reward = await Reward.findOne({ _id: rewardId, deletedAt: null }).lean();
  if (!reward) throw new AppError(404, 'REWARD_NOT_FOUND', 'Reward not found');
  if (reward.status !== 'active' || (reward.startsAt && reward.startsAt > now) || (reward.endsAt && reward.endsAt <= now)) {
    throw new AppError(409, 'REWARD_UNAVAILABLE', FAIL_MESSAGES.REWARD_UNAVAILABLE);
  }

  // Step 1: idempotency gate.
  let redemption;
  try {
    redemption = await Redemption.create({
      userId,
      rewardId: reward._id,
      idempotencyKey,
      price: reward.price,
      status: 'pending',
      rewardSnapshot: {
        name: reward.name,
        imageUrl: reward.imageUrl,
        redemptionDetails: reward.redemptionDetails,
        voucherMode: reward.voucherMode,
      },
    });
  } catch (err) {
    if (!isDupKey(err)) throw err;
    const existing = await Redemption.findOne({ userId, idempotencyKey });
    if (!existing || String(existing.rewardId) !== String(reward._id)) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'That Idempotency-Key was already used for a different request');
    }
    if (existing.status === 'pending') throw new AppError(409, 'IN_PROGRESS', 'This redemption is still being processed. Please wait a moment.');
    if (existing.status === 'failed') {
      throw new AppError(409, existing.failCode || 'REDEMPTION_FAILED', FAIL_MESSAGES[existing.failCode] || 'That redemption did not go through.');
    }
    return { redemption: existing, replayed: true };
  }

  try {
    // Step 2: per-user limit.
    if (reward.perUserLimit != null) {
      if (!(await reserveUserLimit(userId, reward._id, reward.perUserLimit))) throw new AppError(409, 'LIMIT_REACHED', FAIL_MESSAGES.LIMIT_REACHED);
      await markStep(redemption._id, 'limit');
    }

    // Step 3: debit. The filter makes a negative balance impossible even under concurrency.
    const debited = await User.findOneAndUpdate(
      { _id: userId, coinBalance: { $gte: reward.price } },
      { $inc: { coinBalance: -reward.price } },
      { new: true }
    );
    if (!debited) throw new AppError(409, 'INSUFFICIENT_COINS', FAIL_MESSAGES.INSUFFICIENT_COINS);
    await markStep(redemption._id, 'debited');

    // Step 4: stock or voucher.
    let voucher = null;
    if (reward.voucherMode === 'none') {
      if (reward.stock !== null && reward.stock !== undefined) {
        const reserved = await Reward.findOneAndUpdate(
          { _id: reward._id, deletedAt: null, status: 'active', stock: { $gt: 0 } },
          { $inc: { stock: -1 } },
          { new: true }
        );
        if (!reserved) throw new AppError(409, 'OUT_OF_STOCK', FAIL_MESSAGES.OUT_OF_STOCK);
        await markStep(redemption._id, 'stock');
      }
    } else {
      voucher = await VoucherCode.findOneAndUpdate(
        { rewardId: reward._id, status: 'available' },
        { $set: { status: 'assigned', assignedTo: userId, assignedAt: new Date(), redemptionId: redemption._id } },
        { sort: { createdAt: 1 }, new: true }
      );
      if (!voucher) throw new AppError(409, 'OUT_OF_STOCK', FAIL_MESSAGES.OUT_OF_STOCK);
      await markStep(redemption._id, 'voucher');
    }

    // Step 5: ledger.
    const tx = await recordTx({
      userId,
      type: 'redemption',
      amount: -reward.price,
      balanceAfter: debited.coinBalance,
      description: `Redeemed: ${reward.name}`,
      refType: 'redemption',
      refId: redemption._id,
      idempotencyKey: `redeem:${redemption._id}`,
    });

    // Step 6: finalize.
    if (voucher) {
      await VoucherCode.updateOne({ _id: voucher._id, status: 'assigned', assignedTo: userId }, { $set: { status: 'redeemed', redeemedAt: new Date() } });
    }
    const done = await Redemption.findOneAndUpdate(
      { _id: redemption._id, status: 'pending' },
      { $set: { status: 'completed', completedAt: new Date(), voucherCodeId: voucher ? voucher._id : undefined, transactionId: tx._id } },
      { new: true }
    );
    if (!done) throw new AppError(409, 'REDEMPTION_FAILED', 'That redemption could not be completed. Please try again.');
    await Reward.updateOne({ _id: reward._id }, { $inc: { redeemedCount: 1 } });

    return { redemption: done, balance: debited.coinBalance, replayed: false };
  } catch (err) {
    const failCode = err instanceof AppError ? err.code : 'INTERNAL';
    try {
      await failRedemption(redemption._id, failCode);
    } catch (undoErr) {
      logger.error('redemption_undo_failed', { redemptionId: String(redemption._id), message: undoErr.message });
    }
    throw err;
  }
}

// Customer-facing DTO. The voucher code is only ever produced by `withVoucher` for the owner.
function toRedemptionDto(r) {
  const mode = r.rewardSnapshot && r.rewardSnapshot.voucherMode;
  return {
    id: String(r._id),
    rewardId: String(r.rewardId),
    rewardName: r.rewardSnapshot && r.rewardSnapshot.name,
    imageUrl: (r.rewardSnapshot && r.rewardSnapshot.imageUrl) || '',
    redemptionDetails: (r.rewardSnapshot && r.rewardSnapshot.redemptionDetails) || '',
    price: r.price,
    status: r.status,
    hasVoucher: mode === 'reveal' && r.status === 'completed' && Boolean(r.voucherCodeId),
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

// Returns the DTO plus the decrypted code, but only when the redemption belongs to `userId`
// and the reward was configured to reveal vouchers.
async function withVoucher(redemption, userId) {
  const dto = toRedemptionDto(redemption);
  if (!dto.hasVoucher || String(redemption.userId) !== String(userId)) return dto;
  const voucher = await VoucherCode.findOne({ _id: redemption.voucherCodeId, assignedTo: userId, redemptionId: redemption._id });
  if (voucher) dto.voucherCode = revealCode(voucher);
  return dto;
}

module.exports = { redeemReward, toRedemptionDto, withVoucher, compensate, failRedemption };
