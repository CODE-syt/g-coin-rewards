'use strict';

const { Schema, model } = require('mongoose');

const redemptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rewardId: { type: Schema.Types.ObjectId, ref: 'Reward', required: true },
    // Snapshot so history stays accurate if the reward is later edited or removed.
    rewardSnapshot: {
      name: String,
      imageUrl: String,
      redemptionDetails: String,
      voucherMode: String,
    },
    price: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    idempotencyKey: { type: String, required: true },
    voucherCodeId: { type: Schema.Types.ObjectId, ref: 'VoucherCode' },
    transactionId: { type: Schema.Types.ObjectId, ref: 'CoinTransaction' },
    // Saga bookkeeping: which reservations were made, so a failed/stale redemption can be undone exactly once.
    steps: {
      limit: { type: Boolean, default: false },
      debited: { type: Boolean, default: false },
      stock: { type: Boolean, default: false },
      voucher: { type: Boolean, default: false },
    },
    failCode: String,
    completedAt: Date,
    failedAt: Date,
  },
  { timestamps: true }
);

redemptionSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
redemptionSchema.index({ userId: 1, createdAt: -1 });
redemptionSchema.index({ status: 1, createdAt: -1 });
redemptionSchema.index({ rewardId: 1, createdAt: -1 });

module.exports = model('Redemption', redemptionSchema);
