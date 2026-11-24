'use strict';

const { AuditLog } = require('../models');
const logger = require('../lib/logger');

// Keep audit details small and primitive-only; never put secrets or voucher codes here.
function sanitizeDetails(details = {}) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, 100) : x));
    }
  }
  return out;
}

async function audit(req, action, { targetType, targetId, details, admin } = {}) {
  const actor = admin || req.admin;
  try {
    await AuditLog.create({
      adminId: actor ? actor._id : undefined,
      adminEmail: actor ? actor.email : String((req.body && req.body.email) || '').toLowerCase().slice(0, 320),
      action,
      targetType,
      targetId: targetId ? String(targetId) : undefined,
      details: sanitizeDetails(details),
      ip: req.ip,
    });
  } catch (err) {
    logger.error('audit_write_failed', { action, message: err.message });
    // Never turn a completed admin action into a 500; the failure is logged at error level for alerting.
  }
}

module.exports = { audit };
