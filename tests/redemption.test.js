'use strict';

const { setup, teardown, userClient, makeReward, makeUser, key, models } = require('./helpers');
const { redeemReward } = require('../src/services/redemptions');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(teardown);

const attempt = (userId, rewardId, k = key()) => redeemReward({ userId, rewardId, idempotencyKey: k }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code }));

describe('redemption and balance updates', () => {
  test('subtracts the exact price once, and records a transaction + redemption', async () => {
    const reward = await makeReward({ name: 'Mug', price: 7, stock: 3 });
    const user = await makeUser('buyer@example.com', 20);
    const out = await redeemReward({ userId: user._id, rewardId: reward._id, idempotencyKey: key() });
    expect(out.replayed).toBe(false);
    expect(out.balance).toBe(13);
    expect((await models.User.findById(user._id)).coinBalance).toBe(13);
    expect((await models.Reward.findById(reward._id)).stock).toBe(2);
    const tx = await models.CoinTransaction.findOne({ userId: user._id, type: 'redemption' });
    expect(tx.amount).toBe(-7);
    expect(tx.balanceAfter).toBe(13);
    const red = await models.Redemption.findOne({ userId: user._id });
    expect(red.status).toBe('completed');
    expect(red.transactionId).toEqual(tx._id);
  });

  test('replaying the same Idempotency-Key does not charge twice', async () => {
    const reward = await makeReward({ price: 4 });
    const user = await makeUser('replay@example.com', 10);
    const k = key();
    const a = await redeemReward({ userId: user._id, rewardId: reward._id, idempotencyKey: k });
    const b = await redeemReward({ userId: user._id, rewardId: reward._id, idempotencyKey: k });
    expect(b.replayed).toBe(true);
    expect(String(b.redemption._id)).toBe(String(a.redemption._id));
    expect((await models.User.findById(user._id)).coinBalance).toBe(6);
    expect(await models.CoinTransaction.countDocuments({ userId: user._id, type: 'redemption' })).toBe(1);
  });

  test('10 concurrent requests with the SAME key charge exactly once', async () => {
    const reward = await makeReward({ price: 3 });
    const user = await makeUser('samekey@example.com', 30);
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(user._id, reward._id, k)));
    expect(results.filter((x) => x.ok && !x.r.replayed)).toHaveLength(1);
    expect((await models.User.findById(user._id)).coinBalance).toBe(27);
    expect(await models.Redemption.countDocuments({ userId: user._id, status: 'completed' })).toBe(1);
  });

  test('double spending: 10 parallel redemptions with a 5-coin balance succeed exactly once; balance never negative', async () => {
    const reward = await makeReward({ price: 5 });
    const user = await makeUser('double@example.com', 5);
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(user._id, reward._id)));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok).every((x) => x.code === 'INSUFFICIENT_COINS')).toBe(true);
    expect((await models.User.findById(user._id)).coinBalance).toBe(0);
    expect(await models.CoinTransaction.countDocuments({ userId: user._id, type: 'redemption' })).toBe(1);
  });

  test('rejects when the user cannot afford it, leaving everything untouched', async () => {
    const reward = await makeReward({ price: 50, stock: 5 });
    const user = await makeUser('poor@example.com', 49);
    const res = await attempt(user._id, reward._id);
    expect(res).toMatchObject({ ok: false, code: 'INSUFFICIENT_COINS' });
    expect((await models.User.findById(user._id)).coinBalance).toBe(49);
    expect((await models.Reward.findById(reward._id)).stock).toBe(5);
    expect(await models.CoinTransaction.countDocuments({ userId: user._id, type: 'redemption' })).toBe(0);
  });

  test('out of stock refunds the coins and leaves no ledger entry', async () => {
    const reward = await makeReward({ price: 5, stock: 0 });
    const user = await makeUser('nostock@example.com', 10);
    expect(await attempt(user._id, reward._id)).toMatchObject({ ok: false, code: 'OUT_OF_STOCK' });
    expect((await models.User.findById(user._id)).coinBalance).toBe(10);
    expect(await models.CoinTransaction.countDocuments({ userId: user._id, type: 'redemption' })).toBe(0);
  });

  test('stock is never oversold under concurrency', async () => {
    const reward = await makeReward({ price: 2, stock: 3 });
    const users = await Promise.all(Array.from({ length: 12 }, (_, i) => makeUser(`stock${i}@example.com`, 10)));
    const results = await Promise.all(users.map((u) => attempt(u._id, reward._id)));
    expect(results.filter((x) => x.ok)).toHaveLength(3);
    expect((await models.Reward.findById(reward._id)).stock).toBe(0);
    const balances = (await models.User.find({ _id: { $in: users.map((u) => u._id) } })).map((u) => u.coinBalance);
    expect(balances.filter((b) => b === 8)).toHaveLength(3);
    expect(balances.filter((b) => b === 10)).toHaveLength(9);
  });

  test('per-user limit holds under concurrency and refunds the losers', async () => {
    const reward = await makeReward({ price: 2, perUserLimit: 1 });
    const user = await makeUser('limit@example.com', 20);
    const results = await Promise.all(Array.from({ length: 6 }, () => attempt(user._id, reward._id)));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok).every((x) => x.code === 'LIMIT_REACHED')).toBe(true);
    expect((await models.User.findById(user._id)).coinBalance).toBe(18);
  });

  test('inactive, deleted or expired rewards cannot be redeemed', async () => {
    const user = await makeUser('inactive@example.com', 50);
    const inactive = await makeReward({ status: 'inactive' });
    const deleted = await makeReward({ deletedAt: new Date() });
    const ended = await makeReward({ endsAt: new Date(Date.now() - 1000) });
    expect(await attempt(user._id, inactive._id)).toMatchObject({ ok: false, code: 'REWARD_UNAVAILABLE' });
    expect(await attempt(user._id, deleted._id)).toMatchObject({ ok: false, code: 'REWARD_NOT_FOUND' });
    expect(await attempt(user._id, ended._id)).toMatchObject({ ok: false, code: 'REWARD_UNAVAILABLE' });
    expect((await models.User.findById(user._id)).coinBalance).toBe(50);
  });

  test('a stale pending redemption is recovered: all reservations are undone exactly once', async () => {
    const { recoverStaleRedemptions } = require('../src/services/reconcile');
    const reward = await makeReward({ price: 5, voucherMode: 'reveal' }, ['STALE-CODE-0001']);
    const user = await makeUser('stale@example.com', 10);
    // Simulate a crash after the debit and voucher reservation.
    const red = await models.Redemption.create({ userId: user._id, rewardId: reward._id, price: 5, idempotencyKey: key(), status: 'pending', steps: { debited: true, voucher: true }, createdAt: new Date(Date.now() - 3600_000) });
    await models.User.updateOne({ _id: user._id }, { $inc: { coinBalance: -5 } });
    await models.VoucherCode.updateOne({ rewardId: reward._id }, { $set: { status: 'assigned', assignedTo: user._id, redemptionId: red._id } });
    await recoverStaleRedemptions(1000);
    await recoverStaleRedemptions(1000); // idempotent
    expect((await models.User.findById(user._id)).coinBalance).toBe(10);
    expect((await models.VoucherCode.findOne({ rewardId: reward._id })).status).toBe('available');
    expect((await models.Redemption.findById(red._id)).status).toBe('failed');
  });

  test('HTTP flow: confirmation token required, balance returned, history updated', async () => {
    const reward = await makeReward({ name: 'HTTP Reward', price: 5 });
    const c = await userClient(app, 'httpbuy@example.com');
    const noKey = await c.post(`/api/rewards/${reward._id}/redeem`);
    expect(noKey.status).toBe(400);
    const ok = await c.post(`/api/rewards/${reward._id}/redeem`, {}, { 'Idempotency-Key': key() });
    expect(ok.status).toBe(201);
    expect(ok.body.balance).toBe(0);
    const list = await c.get('/api/redemptions');
    expect(list.body.items).toHaveLength(1);
    const again = await c.post(`/api/rewards/${reward._id}/redeem`, {}, { 'Idempotency-Key': key() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INSUFFICIENT_COINS');
  });
});

describe('voucher assignment under concurrency', () => {
  test('no code is ever assigned to two users', async () => {
    const codes = ['CONC-AAAA-0001', 'CONC-AAAA-0002', 'CONC-AAAA-0003'];
    const reward = await makeReward({ price: 5, voucherMode: 'reveal' }, codes);
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`vc${i}@example.com`, 10)));
    const results = await Promise.all(users.map((u) => attempt(u._id, reward._id)));
    const wins = results.filter((x) => x.ok);
    expect(wins).toHaveLength(3);
    const ids = wins.map((w) => String(w.r.redemption.voucherCodeId));
    expect(new Set(ids).size).toBe(3);
    expect(results.filter((x) => !x.ok).every((x) => x.code === 'OUT_OF_STOCK')).toBe(true);
    const vouchers = await models.VoucherCode.find({ rewardId: reward._id });
    expect(vouchers.every((v) => v.status === 'redeemed' && v.assignedTo)).toBe(true);
    expect(new Set(vouchers.map((v) => String(v.assignedTo))).size).toBe(3);
    const losers = users.filter((u) => !wins.some((w) => String(w.r.redemption.userId) === String(u._id)));
    for (const l of losers) expect((await models.User.findById(l._id)).coinBalance).toBe(10);
  });

  test('duplicate codes are rejected at insert (per reward)', async () => {
    const { addCodes } = require('../src/services/vouchers');
    const reward = await makeReward({ voucherMode: 'reveal' });
    const first = await addCodes(reward._id, ['DUP-0001', 'DUP-0002']);
    const second = await addCodes(reward._id, ['DUP-0002', 'DUP-0003']);
    expect(first.added).toBe(2);
    expect(second.added).toBe(1);
    expect(await models.VoucherCode.countDocuments({ rewardId: reward._id })).toBe(3);
  });
});
