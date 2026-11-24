'use strict';

const { CoinTransaction } = require('../models');
const { isDupKey } = require('../lib/util');

// Idempotent ledger write: if a transaction with this key already exists, return it instead of failing.
async function recordTx({ userId, type, amount, balanceAfter, description, refType, refId, idempotencyKey }) {
  try {
    return await CoinTransaction.create({ userId, type, amount, balanceAfter, description, refType, refId, idempotencyKey });
  } catch (err) {
    if (isDupKey(err)) return CoinTransaction.findOne({ idempotencyKey });
    throw err;
  }
}

const toTxDto = (t) => ({
  id: String(t._id),
  type: t.type,
  amount: t.amount,
  balanceAfter: t.balanceAfter,
  description: t.description,
  createdAt: t.createdAt,
});

module.exports = { recordTx, toTxDto };
