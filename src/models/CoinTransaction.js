'use strict';

const { Schema, model } = require('mongoose');
const { TX_TYPES } = require('../constants');

const txSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: TX_TYPES, required: true },
    amount: { type: Number, required: true, validate: Number.isInteger }, // signed
    balanceAfter: { type: Number, default: null },
    description: { type: String, required: true, maxlength: 300 },
    refType: String,
    refId: Schema.Types.ObjectId,
    // Unique key makes ledger writes idempotent (e.g. "signup:<userId>", "redeem:<redemptionId>").
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

txSchema.index({ idempotencyKey: 1 }, { unique: true });
txSchema.index({ userId: 1, createdAt: -1 });
txSchema.index({ type: 1, createdAt: -1 });

module.exports = model('CoinTransaction', txSchema);
