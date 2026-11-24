'use strict';

const { Schema, model } = require('mongoose');
const { VOUCHER_MODES } = require('../constants');

const rewardSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    imageUrl: { type: String, default: '', maxlength: 500 },
    price: { type: Number, required: true, min: 1, validate: Number.isInteger },
    status: { type: String, enum: ['active', 'inactive'], default: 'inactive', index: true },
    // reveal: a code is assigned and shown to the redeeming user only.
    // hidden: a code is assigned (inventory tracked) but never shown in the app.
    // none:   no voucher codes; availability is governed by `stock`.
    voucherMode: { type: String, enum: VOUCHER_MODES, default: 'none' },
    stock: { type: Number, default: null, min: 0, validate: { validator: (v) => v === null || Number.isInteger(v) } },
    perUserLimit: { type: Number, default: null, min: 1 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    redemptionDetails: { type: String, default: '', maxlength: 2000 },
    sortOrder: { type: Number, default: 0 },
    redeemedCount: { type: Number, default: 0, min: 0 },
    deletedAt: { type: Date, default: null },
    seedKey: { type: String, index: { unique: true, sparse: true } },
  },
  { timestamps: true }
);

rewardSchema.index({ deletedAt: 1, status: 1, sortOrder: 1, createdAt: -1 });

module.exports = model('Reward', rewardSchema);
