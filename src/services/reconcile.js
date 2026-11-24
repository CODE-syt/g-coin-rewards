'use strict';

// Repairs the (rare) leftovers of a process crash between two atomic steps. Everything here is
// idempotent, so it is safe to run at startup and on a timer.
const { Redemption, User, Share, CoinTransaction } = require('../models');
const { SIGNUP_BONUS, SHARE_BONUS } = require('../constants');
const { failRedemption } = require('./redemptions');
const { recordTx } = require('./ledger');
const logger = require('../lib/logger');

async function recoverStaleRedemptions(olderThanMs = 5 * 60 * 1000) {
  const stale = await Redemption.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - olderThanMs) } }).limit(100);
  for (const r of stale) {
    await failRedemption(r._id, 'STALE');
    logger.warn('stale_redemption_recovered', { redemptionId: String(r._id) });
  }
  return stale.length;
}

async function backfillMissingLedger() {
  let fixed = 0;
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const users = await User.find({ signupBonusGranted: true, signupBonusAt: { $gte: since } }).select('_id coinBalance').lean();
  const have = new Set((await CoinTransaction.find({ type: 'signup_bonus', userId: { $in: users.map((u) => u._id) } }).select('userId').lean()).map((t) => String(t.userId)));
  for (const u of users) {
    if (!have.has(String(u._id))) {
      await recordTx({ userId: u._id, type: 'signup_bonus', amount: SIGNUP_BONUS, balanceAfter: null, description: 'Welcome bonus', refType: 'user', refId: u._id, idempotencyKey: `signup:${u._id}` });
      fixed += 1;
    }
  }
  const shares = await Share.find({ status: 'credited', creditedAt: { $gte: since } }).select('_id userId rewardId').lean();
  for (const s of shares) {
    const exists = await CoinTransaction.exists({ idempotencyKey: `share:${s.userId}:${s.rewardId}` });
    if (!exists) {
      await recordTx({ userId: s.userId, type: 'share_bonus', amount: SHARE_BONUS, balanceAfter: null, description: 'Share bonus', refType: 'share', refId: s._id, idempotencyKey: `share:${s.userId}:${s.rewardId}` });
      fixed += 1;
    }
  }
  return fixed;
}

async function runReconcile() {
  const [stale, fixed] = [await recoverStaleRedemptions(), await backfillMissingLedger()];
  if (stale || fixed) logger.info('reconcile_done', { stale, fixed });
  return { stale, fixed };
}

module.exports = { runReconcile, recoverStaleRedemptions, backfillMissingLedger };
