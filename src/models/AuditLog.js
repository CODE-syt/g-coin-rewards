'use strict';

const { Schema, model } = require('mongoose');

const auditSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: 'Admin' },
    adminEmail: { type: String, default: '' },
    action: { type: String, required: true },
    targetType: String,
    targetId: String,
    details: { type: Schema.Types.Mixed, default: {} },
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditSchema.index({ createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });
auditSchema.index({ adminId: 1, createdAt: -1 });

module.exports = model('AuditLog', auditSchema);
