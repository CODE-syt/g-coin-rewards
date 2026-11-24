'use strict';

const { Schema, model } = require('mongoose');
const { ADMIN_ROLES } = require('../constants');

const adminSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 320 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ADMIN_ROLES, default: 'admin' },
    disabled: { type: Boolean, default: false },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecretEnc: { type: String, select: false },
    mfaPendingSecretEnc: { type: String, select: false },
    mfaLastStep: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true }
);

module.exports = model('Admin', adminSchema);
