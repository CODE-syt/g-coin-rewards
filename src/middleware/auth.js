'use strict';

const { User, Admin } = require('../models');
const { AppError, asyncHandler } = require('../lib/errors');
const { ROLE_RANK } = require('../constants');

// Attaches req.user when a valid customer session exists; never throws.
const optionalUser = asyncHandler(async (req, res, next) => {
  const id = req.session && req.session.userId;
  if (id) {
    const user = await User.findById(id).lean();
    if (user) req.user = user;
    else delete req.session.userId;
  }
  next();
});

const requireUser = [
  optionalUser,
  (req, res, next) => (req.user ? next() : next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue'))),
];

// Admin authorization is re-checked against the database on every request: a deleted,
// disabled or demoted admin loses access immediately, regardless of session state.
const loadAdmin = asyncHandler(async (req, res, next) => {
  const s = req.session;
  if (s && s.adminId) {
    const maxAgeMs = require('../config').config.security.adminAbsoluteHours * 3600 * 1000;
    if (!s.adminAuthAt || Date.now() - s.adminAuthAt > maxAgeMs) {
      delete s.adminId;
    } else {
      const admin = await Admin.findById(s.adminId);
      if (admin && !admin.disabled) req.admin = admin;
      else delete s.adminId;
    }
  }
  next();
});

const requireAdmin = (minRole = 'viewer') => [
  loadAdmin,
  (req, res, next) => {
    if (!req.admin) return next(new AppError(401, 'UNAUTHENTICATED', 'Admin sign-in required'));
    if (ROLE_RANK[req.admin.role] < ROLE_RANK[minRole]) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this'));
    }
    return next();
  },
];

module.exports = { optionalUser, requireUser, loadAdmin, requireAdmin };
