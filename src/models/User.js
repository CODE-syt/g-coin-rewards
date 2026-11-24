'use strict';

const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    googleId: { type: String, required: true, unique: true, immutable: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    picture: { type: String, default: '', maxlength: 1000 },
    coinBalance: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger, message: 'coinBalance must be an integer' } },
    signupBonusGranted: { type: Boolean, default: false },
    signupBonusAt: Date,
    shareBonusDate: { type: String, default: '' },
    shareBonusCount: { type: Number, default: 0, min: 0 },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ createdAt: -1 });

module.exports = model('User', userSchema);
