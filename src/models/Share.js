'use strict';

const { Schema, model } = require('mongoose');

const shareSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rewardId: { type: Schema.Types.ObjectId, ref: 'Reward', required: true },
    token: { type: String, required: true, unique: true },
    status: { type: String, enum: ['created', 'qualified', 'credited'], default: 'created' },
    creatorFp: { type: String, default: '' },
    visitorFps: { type: [String], default: [] },
    visitCount: { type: Number, default: 0 },
    channel: { type: String, default: '', maxlength: 30 },
    confirmedAt: Date,
    qualifiedAt: Date,
    creditedAt: Date,
  },
  { timestamps: true }
);

// One bonus-eligible share per user per reward, ever.
shareSchema.index({ userId: 1, rewardId: 1 }, { unique: true });

module.exports = model('Share', shareSchema);
