'use strict';

const { Schema, model } = require('mongoose');

// Codes are stored encrypted (AES-256-GCM). `codeHash` is a keyed hash used only to reject duplicates.
const voucherSchema = new Schema(
  {
    rewardId: { type: Schema.Types.ObjectId, ref: 'Reward', required: true },
    codeEnc: { type: String, required: true },
    codeHash: { type: String, required: true },
    last4: { type: String, required: true },
    status: { type: String, enum: ['available', 'assigned', 'redeemed'], default: 'available' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedAt: Date,
    redeemedAt: Date,
    redemptionId: { type: Schema.Types.ObjectId, ref: 'Redemption' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

voucherSchema.index({ rewardId: 1, codeHash: 1 }, { unique: true });
voucherSchema.index({ rewardId: 1, status: 1, createdAt: 1 });
voucherSchema.index({ assignedTo: 1 });

module.exports = model('VoucherCode', voucherSchema);
