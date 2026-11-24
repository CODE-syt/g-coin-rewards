'use strict';

const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const { config } = require('../config');

function build({ name, path, collection, ttlSeconds }) {
  return session({
    name,
    secret: config.security.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      dbName: mongoose.connection.name,
      collectionName: collection,
      ttl: ttlSeconds,
      touchAfter: 60,
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.security.cookieSecure,
      maxAge: ttlSeconds * 1000,
      path,
    },
  });
}

// Customers and admins use different cookies, stores and lifetimes, so a customer session
// can never be mistaken for an admin session (and the admin cookie is only sent to /api/admin).
const userSession = () =>
  build({ name: 'gc.sid', path: '/', collection: 'user_sessions', ttlSeconds: config.security.userSessionHours * 3600 });

const adminSession = () =>
  build({ name: 'gc.admin.sid', path: '/api/admin', collection: 'admin_sessions', ttlSeconds: config.security.adminIdleMinutes * 60 });

const regenerate = (req) =>
  new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
const destroy = (req) => new Promise((resolve) => req.session.destroy(() => resolve()));

module.exports = { userSession, adminSession, regenerate, save, destroy };
