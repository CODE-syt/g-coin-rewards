'use strict';

/**
 * Share & Earn.
 *
 * A "qualifying share" is defined by the server, not by the client:
 *   - the share link is server-issued (unguessable token, bound to one user + one reward);
 *   - with SHARE_REQUIRE_VISIT=true (default) the link must be opened by a *different* browser/device
 *     than the one that created it, by a non-bot, and not while signed in as the sharer;
 *   - with SHARE_REQUIRE_VISIT=false the user confirms the share, but not sooner than
 *     SHARE_MIN_DELAY_SECONDS after the link was created;
 *   - the bonus is paid once per user per reward, and at most SHARE_DAILY_BONUS_LIMIT bonuses per day.
 * Crediting is atomic: share status flips with a conditional update, the daily cap is enforced in
 * the same atomic update that adds the coins, and the ledger row has a unique key.
 */

const { Share, User, Reward } = require('../models');
const { config } = require('../config');
const { SHARE_BONUS } = require('../constants');
const { AppError } = require('../lib/errors');
const { randomToken, hmac } = require('../lib/crypto');
const { dayKey, isDupKey } = require('../lib/util');
const { recordTx } = require('./ledger');
const { visibleFilter } = require('./rewards');

const BOT_RE = /bot|crawler|spider|crawl|slurp|facebookexternalhit|whatsapp|telegram|preview|embedly|curl|wget|python-requests|headless|scanner|monitor|fetch/i;

const fingerprint = (ip, ua) => hmac(`${ip || ''}|${String(ua || '').slice(0, 200)}`, 'share-fp').slice(0, 32);
const shareUrl = (token) => `${config.publicUrl}/r/${token}`;

function toShareDto(share) {
  return {
    id: String(share._id),
    rewardId: String(share.rewardId),
    status: share.status,
    url: shareUrl(share.token),
    visits: share.visitorFps ? share.visitorFps.length : 0,
    createdAt: share.createdAt,
    creditedAt: share.creditedAt,
  };
}

async function createShare(userId, rewardId, { ip, ua, channel } = {}) {
  const reward = await Reward.findOne({ _id: rewardId, ...visibleFilter() }).lean();
  if (!reward) throw new AppError(404, 'REWARD_NOT_FOUND', 'Reward not found');
  const share = await (async () => {
    const run = () =>
      Share.findOneAndUpdate(
        { userId, rewardId: reward._id },
        { $setOnInsert: { token: randomToken(18), status: 'created', creatorFp: fingerprint(ip, ua) }, ...(channel ? { $set: { channel: String(channel).slice(0, 30) } } : {}) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    try {
      return await run();
    } catch (err) {
      if (isDupKey(err)) return run();
      throw err;
    }
  })();
  return share;
}

// Atomically pay the bonus for a qualified share. Returns { credited, capped } or null.
async function tryCredit(shareId) {
  const claimed = await Share.findOneAndUpdate(
    { _id: shareId, status: 'qualified' },
    { $set: { status: 'credited', creditedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return null;

  const today = dayKey(new Date(), config.share.dayTimezone);
  const cap = config.share.dailyBonusLimit;

  // One atomic pipeline update: enforces the daily cap and adds the coins together.
  const user = await User.collection.findOneAndUpdate(
    {
      _id: claimed.userId,
      $or: [{ shareBonusDate: { $ne: today } }, { shareBonusCount: { $lt: cap } }],
    },
    [
      {
        $set: {
          coinBalance: { $add: ['$coinBalance', SHARE_BONUS] },
          shareBonusCount: { $cond: [{ $eq: ['$shareBonusDate', today] }, { $add: ['$shareBonusCount', 1] }, 1] },
          shareBonusDate: today,
        },
      },
    ],
    { returnDocument: 'after' }
  );
  const updated = user && (user.value !== undefined ? user.value : user);

  if (!updated) {
    // Daily cap reached: park the share as qualified again; it can be claimed on a later day.
    await Share.updateOne({ _id: claimed._id, status: 'credited' }, { $set: { status: 'qualified' }, $unset: { creditedAt: 1 } });
    return { credited: false, capped: true };
  }

  const reward = await Reward.findById(claimed.rewardId).lean();
  await recordTx({
    userId: claimed.userId,
    type: 'share_bonus',
    amount: SHARE_BONUS,
    balanceAfter: updated.coinBalance,
    description: `Share bonus: ${reward ? reward.name : 'reward'}`,
    refType: 'share',
    refId: claimed._id,
    idempotencyKey: `share:${claimed.userId}:${claimed.rewardId}`,
  });
  return { credited: true, capped: false };
}

async function qualify(shareId) {
  const q = await Share.findOneAndUpdate(
    { _id: shareId, status: 'created' },
    { $set: { status: 'qualified', qualifiedAt: new Date() } },
    { new: true }
  );
  return q ? tryCredit(shareId) : null;
}

// Called by the public link handler. Never throws on bad input; returns the share (or null).
async function recordVisit(token, { ip, ua, viewerUserId }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
  const share = await Share.findOne({ token });
  if (!share) return null;

  const isBot = !ua || BOT_RE.test(ua);
  const fp = fingerprint(ip, ua);
  const isOwner = viewerUserId && String(viewerUserId) === String(share.userId);
  const sameDevice = fp === share.creatorFp;
  if (isBot || isOwner || sameDevice) return share;

  const added = await Share.updateOne(
    { _id: share._id, visitorFps: { $ne: fp } },
    { $push: { visitorFps: { $each: [fp], $slice: -25 } }, $inc: { visitCount: 1 } }
  );
  if (added.modifiedCount && config.share.requireVisit && share.status === 'created') {
    await qualify(share._id);
  }
  return share;
}

async function confirmShare(userId, shareId) {
  const share = await Share.findOne({ _id: shareId, userId });
  if (!share) throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
  if (!share.confirmedAt) await Share.updateOne({ _id: share._id, confirmedAt: { $exists: false } }, { $set: { confirmedAt: new Date() } });

  if (config.share.requireVisit) return Share.findById(share._id); // bonus waits for a real visit
  if (share.status === 'created') {
    const waitMs = config.share.minDelaySeconds * 1000 - (Date.now() - share.createdAt.getTime());
    if (waitMs > 0) {
      throw new AppError(429, 'TOO_EARLY', `Please finish sharing first. You can confirm in ${Math.ceil(waitMs / 1000)}s.`, { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
    await qualify(share._id);
  }
  return Share.findById(share._id);
}

// Lets a user retry a bonus that was parked because the daily cap had been reached.
async function claimShare(userId, shareId) {
  const share = await Share.findOne({ _id: shareId, userId });
  if (!share) throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
  if (share.status === 'qualified') await tryCredit(share._id);
  return Share.findById(share._id);
}

async function listShares(userId) {
  const shares = await Share.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
  return shares.map(toShareDto);
}

module.exports = { createShare, recordVisit, confirmShare, claimShare, listShares, toShareDto, shareUrl, fingerprint, tryCredit };
