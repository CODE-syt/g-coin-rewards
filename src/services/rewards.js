'use strict';

const { Reward, VoucherCode } = require('../models');
const { LOW_STOCK_THRESHOLD } = require('../constants');
const { escapeRegex, parsePage, pageResult } = require('../lib/util');

// Counts of available codes per reward (only used to derive availability; raw counts are
// never sent to customers).
async function availableVoucherCounts(rewardIds) {
  if (!rewardIds.length) return new Map();
  const rows = await VoucherCode.aggregate([
    { $match: { rewardId: { $in: rewardIds }, status: 'available' } },
    { $group: { _id: '$rewardId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

// 'available' | 'low' | 'out_of_stock' | 'scheduled' | 'ended' | 'unavailable'
function availabilityOf(reward, voucherCount, now = new Date()) {
  if (reward.deletedAt || reward.status !== 'active') return 'unavailable';
  if (reward.endsAt && reward.endsAt <= now) return 'ended';
  if (reward.startsAt && reward.startsAt > now) return 'scheduled';
  const remaining = reward.voucherMode === 'none' ? reward.stock : voucherCount;
  if (remaining === null || remaining === undefined) return 'available';
  if (remaining <= 0) return 'out_of_stock';
  if (remaining <= LOW_STOCK_THRESHOLD) return 'low';
  return 'available';
}

const REDEEMABLE = new Set(['available', 'low']);

// Customer-facing DTO. Deliberately contains no voucher codes and no inventory numbers.
function toPublicReward(reward, voucherCount) {
  const availability = availabilityOf(reward, voucherCount);
  return {
    id: String(reward._id),
    name: reward.name,
    description: reward.description,
    imageUrl: reward.imageUrl || '',
    price: reward.price,
    availability,
    redeemable: REDEEMABLE.has(availability),
    redemptionDetails: reward.redemptionDetails || '',
    revealsVoucher: reward.voucherMode === 'reveal',
    perUserLimit: reward.perUserLimit,
    startsAt: reward.startsAt,
    endsAt: reward.endsAt,
  };
}

function visibleFilter(now = new Date()) {
  return {
    deletedAt: null,
    status: 'active',
    $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
  };
}

async function listPublicRewards(query = {}) {
  const pg = parsePage(query, { defaultLimit: 12, maxLimit: 48 });
  const filter = visibleFilter();
  if (query.q) filter.name = { $regex: escapeRegex(String(query.q).slice(0, 60)), $options: 'i' };
  const [rewards, total] = await Promise.all([
    Reward.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    Reward.countDocuments(filter),
  ]);
  const counts = await availableVoucherCounts(rewards.filter((r) => r.voucherMode !== 'none').map((r) => r._id));
  return pageResult(rewards.map((r) => toPublicReward(r, counts.get(String(r._id)) || 0)), total, pg);
}

async function getPublicReward(id) {
  const reward = await Reward.findOne({ _id: id, ...visibleFilter() }).lean();
  if (!reward) return null;
  const counts = reward.voucherMode === 'none' ? new Map() : await availableVoucherCounts([reward._id]);
  return toPublicReward(reward, counts.get(String(reward._id)) || 0);
}

module.exports = { availableVoucherCounts, availabilityOf, toPublicReward, listPublicRewards, getPublicReward, visibleFilter, REDEEMABLE };
