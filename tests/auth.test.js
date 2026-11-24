'use strict';

const { setup, teardown, userClient, models } = require('./helpers');
const { signInWithGoogleProfile } = require('../src/services/userAuth');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(teardown);

const profile = (n) => ({ sub: `google-${n}`, email: `User${n}@Example.com`, name: `User ${n}`, picture: 'https://example.com/p.png' });

describe('first sign-in bonus', () => {
  test('awards exactly 5 coins once, then never again on repeated sign-ins', async () => {
    const first = await signInWithGoogleProfile(profile(1));
    expect(first.isNew).toBe(true);
    expect(first.bonusGranted).toBe(5);
    expect(first.user.coinBalance).toBe(5);

    for (let i = 0; i < 4; i += 1) {
      const again = await signInWithGoogleProfile(profile(1));
      expect(again.isNew).toBe(false);
      expect(again.bonusGranted).toBe(0);
      expect(again.user.coinBalance).toBe(5);
    }
    const u = await models.User.findOne({ googleId: 'google-1' });
    expect(u.coinBalance).toBe(5);
    expect(await models.CoinTransaction.countDocuments({ userId: u._id, type: 'signup_bonus' })).toBe(1);
  });

  test('20 concurrent first sign-ins still produce a single user, a single bonus and a single ledger row', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => signInWithGoogleProfile(profile(2))));
    expect(results.filter((r) => r.bonusGranted === 5)).toHaveLength(1);
    expect(await models.User.countDocuments({ googleId: 'google-2' })).toBe(1);
    const u = await models.User.findOne({ googleId: 'google-2' });
    expect(u.coinBalance).toBe(5);
    expect(await models.CoinTransaction.countDocuments({ userId: u._id, type: 'signup_bonus' })).toBe(1);
  });

  test('email is normalised and stored from the verified profile', async () => {
    const u = await models.User.findOne({ googleId: 'google-1' });
    expect(u.email).toBe('user1@example.com');
  });

  test('over HTTP: logging in, out and in again keeps the balance at 5', async () => {
    const a = await userClient(app, 'http-user@example.com');
    expect(a.user.balance).toBe(5);
    await a.post('/api/auth/logout');
    const b = await userClient(app, 'http-user@example.com');
    expect(b.user.balance).toBe(5);
    const txs = await b.get('/api/me/transactions');
    expect(txs.body.items.filter((t) => t.type === 'signup_bonus')).toHaveLength(1);
  });
});

describe('sessions and server-side authorization', () => {
  test('protected endpoints reject anonymous requests', async () => {
    const request = require('supertest');
    for (const p of ['/api/me', '/api/me/transactions', '/api/rewards', '/api/redemptions', '/api/shares']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(401);
    }
  });

  test('state-changing requests without a CSRF token are rejected', async () => {
    const c = await userClient(app, 'csrf@example.com');
    const res = await c.agent.post('/api/shares').send({ rewardId: '0'.repeat(24) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });

  test('cross-origin state-changing requests are blocked', async () => {
    const c = await userClient(app, 'origin@example.com');
    const res = await c.post('/api/shares', { rewardId: '0'.repeat(24) }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  test('session cookie is HttpOnly + SameSite and rotates on login (no fixation)', async () => {
    const request = require('supertest');
    const agent = request.agent(app);
    const pre = await agent.get('/api/session');
    const preCookie = pre.headers['set-cookie'].find((c) => c.startsWith('gc.sid='));
    const s = pre.body.csrfToken;
    const login = await agent.post('/api/auth/dev-login').set('x-csrf-token', s).send({ email: 'fix@example.com' });
    const postCookie = login.headers['set-cookie'].find((c) => c.startsWith('gc.sid='));
    expect(postCookie).toMatch(/HttpOnly/i);
    expect(postCookie).toMatch(/SameSite=Lax/i);
    expect(postCookie.split(';')[0]).not.toBe(preCookie.split(';')[0]);
    expect(login.body.csrfToken).not.toBe(s);
  });

  test('API responses never include internals or secrets', async () => {
    const c = await userClient(app, 'leak@example.com');
    const res = await c.get('/api/me');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/googleId|passwordHash|SESSION_SECRET|__v/);
    const bad = await c.get('/api/rewards/not-an-id');
    expect(bad.status).toBe(404);
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|mongoose|Cast/i);
  });
});
