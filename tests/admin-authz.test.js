'use strict';

const request = require('supertest');
const { setup, teardown, userClient, adminClient, makeAdmin, makeReward, PASSWORD, key, models } = require('./helpers');
const { encrypt } = require('../src/lib/crypto');
const totp = require('../src/lib/totp');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(teardown);

const ADMIN_GETS = ['/api/admin/stats', '/api/admin/rewards', '/api/admin/users', '/api/admin/transactions', '/api/admin/redemptions', '/api/admin/inventory', '/api/admin/audit'];

describe('admin authorization is enforced on the server', () => {
  test('anonymous requests are rejected on every admin endpoint', async () => {
    for (const p of ADMIN_GETS) expect((await request(app).get(p)).status).toBe(401);
    const agent = request.agent(app);
    const s = await agent.get('/api/admin/session');
    const post = await agent.post('/api/admin/rewards').set('x-csrf-token', s.body.csrfToken).send({ name: 'x', description: 'y', price: 1 });
    expect(post.status).toBe(401);
  });

  test('a signed-in CUSTOMER session grants no admin access', async () => {
    const user = await userClient(app, 'customer@example.com');
    for (const p of ADMIN_GETS) expect((await user.get(p)).status).toBe(401);
    const adminCsrf = (await user.get('/api/admin/session')).body.csrfToken; // a valid admin-session CSRF token, but no admin login
    const res = await user.agent.post('/api/admin/rewards').set('x-csrf-token', adminCsrf).send({ name: 'Hack', description: 'x', price: 1 });
    expect(res.status).toBe(401);
    const reuse = await user.agent.post('/api/admin/rewards').set('x-csrf-token', user.csrf).send({ name: 'Hack', description: 'x', price: 1 });
    expect([401, 403]).toContain(reuse.status);
    expect(await models.Reward.countDocuments({ name: 'Hack' })).toBe(0);
  });

  test('tampering with the customer cookie value does not create an admin session', async () => {
    const res = await request(app).get('/api/admin/stats').set('Cookie', 'gc.admin.sid=s%3Aforged.signature; gc.sid=forged');
    expect(res.status).toBe(401);
  });

  test('wrong credentials fail with a generic message (no user enumeration)', async () => {
    await makeAdmin('real@example.com', 'admin');
    const bad = await adminClient(app, 'real@example.com', { password: 'Wrong-Password-1!' });
    const nobody = await adminClient(app, 'nobody@example.com', { password: 'Wrong-Password-1!' });
    expect(bad.res.status).toBe(401);
    expect(nobody.res.status).toBe(401);
    expect(bad.res.body.error.message).toBe(nobody.res.body.error.message);
  });

  test('admin passwords are stored as bcrypt hashes and never returned', async () => {
    const a = await models.Admin.findOne({ email: 'real@example.com' }).select('+passwordHash');
    expect(a.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(a.passwordHash).not.toContain(PASSWORD);
    const c = await adminClient(app, 'real@example.com');
    expect(JSON.stringify(c.res.body)).not.toMatch(/passwordHash|mfaSecret|\$2a\$/);
  });

  test('state-changing admin calls need the CSRF token', async () => {
    await makeAdmin('csrf-admin@example.com', 'admin');
    const c = await adminClient(app, 'csrf-admin@example.com');
    const res = await c.agent.post('/api/admin/rewards').send({ name: 'No CSRF', description: 'x', price: 3 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });

  test('roles: viewer is read-only, admin cannot delete, superadmin can (with password re-entry)', async () => {
    await makeAdmin('viewer@example.com', 'viewer');
    await makeAdmin('manager@example.com', 'admin');
    await makeAdmin('boss@example.com', 'superadmin');
    const body = { name: 'Role Reward', description: 'd', price: 10 };

    const viewer = await adminClient(app, 'viewer@example.com');
    expect((await viewer.get('/api/admin/rewards')).status).toBe(200);
    expect((await viewer.send('post', '/api/admin/rewards', body)).status).toBe(403);

    const manager = await adminClient(app, 'manager@example.com');
    const created = await manager.send('post', '/api/admin/rewards', body);
    expect(created.status).toBe(201);
    const id = created.body.reward.id;
    expect((await manager.send('patch', `/api/admin/rewards/${id}`, { price: 12 })).status).toBe(200);
    expect((await manager.send('delete', `/api/admin/rewards/${id}`, { confirmPassword: PASSWORD })).status).toBe(403);
    expect((await manager.send('post', `/api/admin/rewards/${id}/vouchers`, { codes: ['ROLE-CODE-0001'] })).status).toBe(409); // mode "none"

    const boss = await adminClient(app, 'boss@example.com');
    const noPw = await boss.send('delete', `/api/admin/rewards/${id}`, {});
    expect(noPw.status).toBe(400);
    const wrong = await boss.send('delete', `/api/admin/rewards/${id}`, { confirmPassword: 'Not-The-Password-1' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('REAUTH_FAILED');
    expect((await models.Reward.findById(id)).deletedAt).toBeNull();
    const ok = await boss.send('delete', `/api/admin/rewards/${id}`, { confirmPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await models.Reward.findById(id)).deletedAt).not.toBeNull();
    // Soft-deleted rewards disappear for customers.
    const cust = await userClient(app, 'cust2@example.com');
    expect((await cust.get(`/api/rewards/${id}`)).status).toBe(404);
  });

  test('voucher codes: added, tracked, masked; only unassigned codes can be deleted', async () => {
    const reward = await makeReward({ name: 'Vouch', voucherMode: 'reveal', price: 5 });
    const boss = await adminClient(app, 'boss@example.com');
    const add = await boss.send('post', `/api/admin/rewards/${reward._id}/vouchers`, { codes: ['VC-AAAA-0001', 'VC-AAAA-0002', 'VC-AAAA-0001', 'bad code', 'x'] });
    expect(add.body).toMatchObject({ added: 2, invalid: 2, duplicates: 1 });
    const user = await userClient(app, 'vcbuyer@example.com');
    await user.post(`/api/rewards/${reward._id}/redeem`, {}, { 'Idempotency-Key': key() });
    const list = (await boss.get(`/api/admin/rewards/${reward._id}/vouchers`)).body.items;
    expect(list.map((v) => v.status).sort()).toEqual(['available', 'redeemed']);
    const redeemed = list.find((v) => v.status === 'redeemed');
    const avail = list.find((v) => v.status === 'available');
    expect(redeemed.assignedTo).toBe('vcbuyer@example.com');
    const del1 = await boss.send('delete', `/api/admin/vouchers/${redeemed.id}`, { confirmPassword: PASSWORD });
    expect(del1.status).toBe(409);
    const del2 = await boss.send('delete', `/api/admin/vouchers/${avail.id}`, { confirmPassword: PASSWORD });
    expect(del2.status).toBe(200);
  });

  test('important actions land in the audit log, without secrets', async () => {
    const boss = await adminClient(app, 'boss@example.com');
    const audit = (await boss.get('/api/admin/audit?limit=100')).body.items;
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['admin.login', 'admin.login_failed', 'reward.create', 'reward.update', 'reward.delete', 'voucher.add', 'voucher.delete', 'admin.reauth_failed']) expect(actions).toContain(a);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('VC-AAAA-0001');
  });

  test('admin validation rejects bad input (negative price, unknown fields, bad image URL)', async () => {
    const boss = await adminClient(app, 'boss@example.com');
    expect((await boss.send('post', '/api/admin/rewards', { name: 'Neg', description: 'd', price: -5 })).status).toBe(400);
    expect((await boss.send('post', '/api/admin/rewards', { name: 'Evil', description: 'd', price: 5, redeemedCount: 99 })).status).toBe(400);
    expect((await boss.send('post', '/api/admin/rewards', { name: 'Img', description: 'd', price: 5, imageUrl: 'javascript:alert(1)' })).status).toBe(400);
  });

  test('a disabled admin loses access immediately, even with a live session', async () => {
    await makeAdmin('fired@example.com', 'admin');
    const c = await adminClient(app, 'fired@example.com');
    expect((await c.get('/api/admin/stats')).status).toBe(200);
    await models.Admin.updateOne({ email: 'fired@example.com' }, { $set: { disabled: true } });
    expect((await c.get('/api/admin/stats')).status).toBe(401);
  });

  test('a demoted admin loses privileges immediately', async () => {
    await makeAdmin('demote@example.com', 'admin');
    const c = await adminClient(app, 'demote@example.com');
    expect((await c.send('post', '/api/admin/rewards', { name: 'Before', description: 'd', price: 2 })).status).toBe(201);
    await models.Admin.updateOne({ email: 'demote@example.com' }, { $set: { role: 'viewer' } });
    expect((await c.send('post', '/api/admin/rewards', { name: 'After', description: 'd', price: 2 })).status).toBe(403);
  });

  test('brute force: repeated bad passwords lock the account, even for the right password', async () => {
    await makeAdmin('locked@example.com', 'admin');
    for (let i = 0; i < 5; i += 1) await adminClient(app, 'locked@example.com', { password: 'Wrong-Password-1!' });
    const right = await adminClient(app, 'locked@example.com');
    expect(right.res.status).toBe(429);
    expect(right.res.body.error.code).toBe('LOCKED');
  });
});

describe('admin MFA (TOTP)', () => {
  const SECRET = totp.generateSecret();
  beforeAll(async () => { await makeAdmin('mfa@example.com', 'admin', { mfaEnabled: true, mfaSecretEnc: encrypt(SECRET, 'mfa') }); });

  test('password alone is not enough; a valid code is; the same code cannot be replayed', async () => {
    const noCode = await adminClient(app, 'mfa@example.com');
    expect(noCode.res.status).toBe(401);
    expect(noCode.res.body.error.code).toBe('MFA_REQUIRED');

    const wrong = await adminClient(app, 'mfa@example.com', { code: '000000' });
    expect(wrong.res.status).toBe(401);

    const code = totp.codeForStep(SECRET, totp.currentStep());
    const ok = await adminClient(app, 'mfa@example.com', { code });
    expect(ok.res.status).toBe(200);
    expect(ok.res.body.admin.mfaEnabled).toBe(true);

    const replay = await adminClient(app, 'mfa@example.com', { code });
    expect(replay.res.status).toBe(401);
  });

  test('sensitive actions also demand a fresh authenticator code', async () => {
    await models.Admin.updateOne({ email: 'mfa@example.com' }, { $set: { role: 'superadmin', mfaLastStep: 0 } });
    const reward = await makeReward({ name: 'MFA Delete' });
    const c = await adminClient(app, 'mfa@example.com', { code: totp.codeForStep(SECRET, totp.currentStep()) });
    expect(c.res.status).toBe(200);
    const noCode = await c.send('delete', `/api/admin/rewards/${reward._id}`, { confirmPassword: PASSWORD });
    expect(noCode.status).toBe(403);
    const ok = await c.send('delete', `/api/admin/rewards/${reward._id}`, { confirmPassword: PASSWORD, confirmCode: totp.codeForStep(SECRET, totp.currentStep()) });
    expect(ok.status).toBe(200);
  });

  test('ADMIN_REQUIRE_MFA blocks admins who have not enrolled', async () => {
    const { config } = require('../src/config');
    config.security.adminRequireMfa = true;
    try {
      await makeAdmin('nomfa@example.com', 'admin');
      const c = await adminClient(app, 'nomfa@example.com');
      expect(c.res.body.mfaEnrollmentRequired).toBe(true);
      const res = await c.get('/api/admin/stats');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    } finally { config.security.adminRequireMfa = false; }
  });
});
