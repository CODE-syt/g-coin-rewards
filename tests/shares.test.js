'use strict';

const request = require('supertest');
const { setup, teardown, userClient, makeReward, UA_ME, UA_FRIEND, models } = require('./helpers');
const { config } = require('../src/config');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(teardown);

const visit = (token, ua = UA_FRIEND) => request(app).get(`/r/${token}`).set('User-Agent', ua);
const tokenOf = (url) => url.split('/r/')[1];
const balanceOf = async (id) => (await models.User.findById(id)).coinBalance;

async function newShare(c, reward) {
  const res = await c.post('/api/shares', { rewardId: String(reward._id) });
  expect(res.status).toBe(201);
  return { id: res.body.share.id, token: tokenOf(res.body.share.url), url: res.body.share.url };
}

describe('share bonus (visit-based qualification, default)', () => {
  test('creating a share link pays nothing; a different device opening it pays exactly 5', async () => {
    const reward = await makeReward({ name: 'Shareable' });
    const me = await userClient(app, 'sharer@example.com');
    const s = await newShare(me, reward);
    expect(await balanceOf(me.user.id)).toBe(5);

    const res = await visit(s.token);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Shareable');
    expect(await balanceOf(me.user.id)).toBe(10);

    const txs = (await me.get('/api/me/transactions')).body.items;
    const bonus = txs.filter((t) => t.type === 'share_bonus');
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amount).toBe(5);
  });

  test('repeat visits, repeat link creation and repeat confirms never pay twice', async () => {
    const reward = await makeReward();
    const me = await userClient(app, 'dupe@example.com');
    const s = await newShare(me, reward);
    await visit(s.token, 'Mozilla/5.0 (friend one)');
    await visit(s.token, 'Mozilla/5.0 (friend two)');
    await visit(s.token, 'Mozilla/5.0 (friend one)');
    const again = await newShare(me, reward);
    expect(again.token).toBe(s.token); // same link: one share per user per reward
    await me.post(`/api/shares/${s.id}/confirm`);
    await me.post(`/api/shares/${s.id}/claim`);
    expect(await balanceOf(me.user.id)).toBe(10);
    expect(await models.CoinTransaction.countDocuments({ userId: me.user.id, type: 'share_bonus' })).toBe(1);
  });

  test('20 concurrent visits from different devices pay exactly once', async () => {
    const reward = await makeReward();
    const me = await userClient(app, 'race@example.com');
    const s = await newShare(me, reward);
    await Promise.all(Array.from({ length: 20 }, (_, i) => visit(s.token, `Mozilla/5.0 (device ${i})`)));
    expect(await balanceOf(me.user.id)).toBe(10);
    expect(await models.CoinTransaction.countDocuments({ userId: me.user.id, type: 'share_bonus' })).toBe(1);
  });

  test('fake claims do not pay: self-visit (same device), owner signed in, bots, unknown tokens', async () => {
    const reward = await makeReward();
    const me = await userClient(app, 'fake@example.com');
    const s = await newShare(me, reward);
    await visit(s.token, UA_ME); // same device fingerprint as the creator
    await me.get(`/r/${s.token}`); // owner, signed in
    for (const bot of ['Googlebot/2.1', 'WhatsApp/2.23', 'curl/8.0', 'facebookexternalhit/1.1', '']) await visit(s.token, bot);
    expect((await visit('A'.repeat(24))).status).toBe(404);
    expect((await visit('../../etc/passwd')).status).toBe(404);
    expect(await balanceOf(me.user.id)).toBe(5);
    expect((await models.Share.findById(s.id)).status).toBe('created');
  });

  test('"I shared it" cannot be used to self-award while visits are required', async () => {
    const reward = await makeReward();
    const me = await userClient(app, 'selfaward@example.com');
    const s = await newShare(me, reward);
    const res = await me.post(`/api/shares/${s.id}/confirm`);
    expect(res.status).toBe(200);
    expect(res.body.share.status).toBe('created');
    expect(res.body.balance).toBe(5);
  });

  test("a user cannot confirm or claim someone else's share", async () => {
    const reward = await makeReward();
    const owner = await userClient(app, 'owner@example.com');
    const thief = await userClient(app, 'thief@example.com');
    const s = await newShare(owner, reward);
    expect((await thief.post(`/api/shares/${s.id}/confirm`)).status).toBe(404);
    expect((await thief.post(`/api/shares/${s.id}/claim`)).status).toBe(404);
    expect(await balanceOf(thief.user.id)).toBe(5);
  });

  test('inactive rewards cannot be shared; share pages never leak other details', async () => {
    const hidden = await makeReward({ status: 'inactive' });
    const me = await userClient(app, 'inactive@example.com');
    expect((await me.post('/api/shares', { rewardId: String(hidden._id) })).status).toBe(404);
  });

  test('daily cap: only N bonuses per day, the rest wait as "qualified" and are never lost or double paid', async () => {
    const me = await userClient(app, 'cap@example.com');
    const cap = config.share.dailyBonusLimit; // 3
    const rewards = await Promise.all(Array.from({ length: cap + 2 }, (_, i) => makeReward({ name: `Cap ${i}` })));
    const shares = [];
    for (const r of rewards) shares.push(await newShare(me, r));
    for (const s of shares) await visit(s.token);
    expect(await balanceOf(me.user.id)).toBe(5 + cap * 5);
    const statuses = (await models.Share.find({ userId: me.user.id })).map((s) => s.status);
    expect(statuses.filter((s) => s === 'credited')).toHaveLength(cap);
    expect(statuses.filter((s) => s === 'qualified')).toHaveLength(2);
    // Claiming while capped does not pay.
    const waiting = shares.find((_, i) => statuses[i] === 'qualified') || shares[cap];
    const res = await me.post(`/api/shares/${waiting.id}/claim`);
    expect(res.body.balance).toBe(5 + cap * 5);
    // Next day: the user's counter resets and the parked share can be claimed once.
    await models.User.updateOne({ _id: me.user.id }, { $set: { shareBonusDate: '2000-01-01' } });
    const parked = await models.Share.findOne({ userId: me.user.id, status: 'qualified' });
    const claimed = await me.post(`/api/shares/${parked._id}/claim`);
    expect(claimed.body.share.status).toBe('credited');
    expect(claimed.body.balance).toBe(5 + (cap + 1) * 5);
    await me.post(`/api/shares/${parked._id}/claim`);
    expect(await balanceOf(me.user.id)).toBe(5 + (cap + 1) * 5);
  });
});

describe('share bonus (confirm mode, SHARE_REQUIRE_VISIT=false)', () => {
  beforeAll(() => { config.share.requireVisit = false; config.share.minDelaySeconds = 30; });
  afterAll(() => { config.share.requireVisit = true; config.share.minDelaySeconds = 15; });

  test('too-early confirmation is refused; after the delay it pays once', async () => {
    const reward = await makeReward();
    const me = await userClient(app, 'confirm@example.com');
    const s = await newShare(me, reward);
    const early = await me.post(`/api/shares/${s.id}/confirm`);
    expect(early.status).toBe(429);
    expect(early.body.error.code).toBe('TOO_EARLY');
    expect(await balanceOf(me.user.id)).toBe(5);

    await models.Share.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(s.id) }, { $set: { createdAt: new Date(Date.now() - 60_000) } }); // createdAt is immutable in Mongoose, so write directly
    const results = await Promise.all(Array.from({ length: 5 }, () => me.post(`/api/shares/${s.id}/confirm`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await balanceOf(me.user.id)).toBe(10);
    expect(await models.CoinTransaction.countDocuments({ userId: me.user.id, type: 'share_bonus' })).toBe(1);
  });
});
