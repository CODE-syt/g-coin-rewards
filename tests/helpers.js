'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { connectDb, disconnectDb } = require('../src/db');
const models = require('../src/models');
const { createApp } = require('../src/app');
const { addCodes } = require('../src/services/vouchers');
const { signInWithGoogleProfile } = require('../src/services/userAuth');

async function setup() {
  await connectDb();
  if (!/test/i.test(mongoose.connection.name)) throw new Error(`Refusing to wipe database "${mongoose.connection.name}": its name must contain "test"`);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
  return createApp();
}
const teardown = () => disconnectDb();

const UA_ME = 'Mozilla/5.0 (Linux; Android 14) GCoinTest/Owner';
const UA_FRIEND = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) GCoinTest/Friend';

// A signed-in browser: cookie jar + CSRF token, via the dev-login route (Google is not available in tests).
async function userClient(app, email, { ua = UA_ME } = {}) {
  const agent = request.agent(app).set('User-Agent', ua);
  const s = await agent.get('/api/session');
  const r = await agent.post('/api/auth/dev-login').set('x-csrf-token', s.body.csrfToken).send({ email, name: email.split('@')[0] });
  if (r.status !== 200) throw new Error(`dev-login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const c = { agent, csrf: r.body.csrfToken, user: r.body.user };
  c.get = (p) => agent.get(p);
  c.post = (p, body, headers = {}) => agent.post(p).set('x-csrf-token', c.csrf).set(headers).send(body || {});
  return c;
}

// A visitor who is not signed in (has a session cookie + CSRF token only).
async function anonClient(app) {
  const agent = request.agent(app).set('User-Agent', UA_ME);
  const s = await agent.get('/api/session');
  const c = { agent, csrf: s.body.csrfToken };
  c.post = (p, body, headers = {}) => agent.post(p).set('x-csrf-token', c.csrf).set(headers).send(body === undefined ? {} : body);
  return c;
}

const PASSWORD = 'Correct-Horse-9!';
async function makeAdmin(email, role = 'admin', extra = {}) {
  return models.Admin.create({ email, name: email.split('@')[0], role, passwordHash: await bcrypt.hash(PASSWORD, 4), ...extra });
}

async function adminClient(app, email, { password = PASSWORD, code } = {}) {
  const agent = request.agent(app);
  const s = await agent.get('/api/admin/session');
  const csrf0 = s.body.csrfToken;
  const res = await agent.post('/api/admin/login').set('x-csrf-token', csrf0).send({ email, password, ...(code ? { code } : {}) });
  const c = { agent, res, csrf: res.body.csrfToken || csrf0 };
  c.get = (p) => agent.get(p);
  c.send = (method, p, body) => agent[method](p).set('x-csrf-token', c.csrf).send(body || {});
  return c;
}

async function makeReward(fields = {}, codes = []) {
  const reward = await models.Reward.create({ name: 'Test Reward', description: 'desc', price: 5, status: 'active', voucherMode: 'none', ...fields });
  if (codes.length) await addCodes(reward._id, codes);
  return reward;
}

async function makeUser(email, balance = 0) {
  const { user } = await signInWithGoogleProfile({ sub: `t:${email}`, email, name: email.split('@')[0] });
  await models.User.updateOne({ _id: user._id }, { $set: { coinBalance: balance } });
  return models.User.findById(user._id);
}

const key = () => `k${Math.random().toString(36).slice(2)}${Date.now()}`;

module.exports = { setup, teardown, userClient, anonClient, adminClient, makeAdmin, makeReward, makeUser, key, PASSWORD, UA_ME, UA_FRIEND, models };
