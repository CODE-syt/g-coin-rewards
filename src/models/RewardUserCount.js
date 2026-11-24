'use strict';

const { Schema, model } = require('mongoose');

// Atomic per-user redemption counter used to enforce a reward's perUserLimit under concurrency.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  rewardId: { type: Schema.Types.ObjectId, required: true },
  count: { type: Number, default: 0, min: 0 },
});
schema.index({ userId: 1, rewardId: 1 }, { unique: true });

module.exports = model('RewardUserCount', schema);
