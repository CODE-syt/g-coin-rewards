'use strict';

const { setup, teardown, userClient, adminClient, makeAdmin, makeReward, key, models } = require('./helpers');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(teardown);

const CODES = ['SECRET-ALPHA-1111', 'SECRET-BRAVO-2222', 'SECRET-CHARLIE-3333'];
const NO_CODES = (obj) => CODES.forEach((c) => expect(JSON.stringify(obj)).not.toContain(c));

describe('voucher privacy', () => {
  let reveal; let hidden; let alice; let bob; let aliceCode;
  beforeAll(async () => {
    reveal = await makeReward({ name: 'Reveal Reward', price: 5, voucherMode: 'reveal' }, CODES);
    hidden = await makeReward({ name: 'Hidden Reward', price: 5, voucherMode: 'hidden' }, ['HIDDEN-ONLY-9999']);
    alice = await userClient(app, 'alice@example.com');
    bob = await userClient(app, 'bob@example.com');
  });

  test('codes are encrypted at rest (no plaintext in the database)', async () => {
    const docs = await models.VoucherCode.find({ rewardId: reveal._id }).lean();
    expect(docs).toHaveLength(3);
    for (const d of docs) {
      const raw = JSON.stringify(d);
      CODES.forEach((c) => expect(raw).not.toContain(c));
      expect(d.codeEnc.startsWith('v1.')).toBe(true);
    }
  });

  test('reward catalog (list + detail) never contains codes or raw inventory counts', async () => {
    const list = await alice.get('/api/rewards');
    NO_CODES(list.body);
    expect(JSON.stringify(list.body)).not.toMatch(/codeEnc|codeHash|"stock"|inventory|availableCount/);
    const detail = await alice.get(`/api/rewards/${reveal._id}`);
    NO_CODES(detail.body);
    expect(detail.body.reward.revealsVoucher).toBe(true);
  });

  test('the redeeming user receives their code, and only theirs', async () => {
    const r = await alice.post(`/api/rewards/${reveal._id}/redeem`, {}, { 'Idempotency-Key': key() });
    expect(r.status).toBe(201);
    expect(CODES).toContain(r.body.redemption.voucherCode);
    aliceCode = r.body.redemption.voucherCode;
    const detail = await alice.get(`/api/redemptions/${r.body.redemption.id}`);
    expect(detail.body.redemption.voucherCode).toBe(aliceCode);
    alice.redemptionId = r.body.redemption.id;
  });

  test('the redemption LIST never includes codes (only the owner-scoped detail does)', async () => {
    const list = await alice.get('/api/redemptions');
    NO_CODES(list.body);
    expect(list.body.items[0].hasVoucher).toBe(true);
  });

  test("another user cannot read Alice's redemption or code (404, not 403)", async () => {
    const res = await bob.get(`/api/redemptions/${alice.redemptionId}`);
    expect(res.status).toBe(404);
    NO_CODES(res.body);
    const bobList = await bob.get('/api/redemptions');
    expect(bobList.body.items).toHaveLength(0);
  });

  test("Bob's own redemption gets a different code, and Alice's code is not in Bob's responses", async () => {
    const r = await bob.post(`/api/rewards/${reveal._id}/redeem`, {}, { 'Idempotency-Key': key() });
    expect(r.status).toBe(201);
    expect(r.body.redemption.voucherCode).not.toBe(aliceCode);
    expect(JSON.stringify(r.body)).not.toContain(aliceCode);
  });

  test('"hidden" rewards assign a code internally but never show it', async () => {
    const carol = await userClient(app, 'carol@example.com');
    const r = await carol.post(`/api/rewards/${hidden._id}/redeem`, {}, { 'Idempotency-Key': key() });
    expect(r.status).toBe(201);
    expect(r.body.redemption.voucherCode).toBeUndefined();
    expect(r.body.redemption.hasVoucher).toBe(false);
    const detail = await carol.get(`/api/redemptions/${r.body.redemption.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('HIDDEN-ONLY-9999');
    expect(await models.VoucherCode.countDocuments({ rewardId: hidden._id, status: 'redeemed' })).toBe(1);
  });

  test('the chatbot never reveals a code, even when asked and when the model is mocked to try', async () => {
    const res = await alice.post('/api/chat', { message: 'What is my voucher code for the reveal reward?' });
    expect(res.status).toBe(200);
    NO_CODES(res.body);
  });

  test('admin APIs only expose masked codes (last 4), never plaintext', async () => {
    await makeAdmin('super@example.com', 'superadmin');
    const adm = await adminClient(app, 'super@example.com');
    expect(adm.res.status).toBe(200);
    const list = await adm.get(`/api/admin/rewards/${reveal._id}/vouchers`);
    expect(list.status).toBe(200);
    NO_CODES(list.body);
    expect(list.body.items.every((v) => v.maskedCode.startsWith('••••'))).toBe(true);
    const reds = await adm.get('/api/admin/redemptions');
    NO_CODES(reds.body);
    const audit = await adm.get('/api/admin/audit');
    NO_CODES(audit.body);
  });
});
