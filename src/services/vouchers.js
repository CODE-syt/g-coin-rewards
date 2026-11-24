'use strict';

const { VoucherCode } = require('../models');
const { encrypt, decrypt, hmac } = require('../lib/crypto');
const { isDupKey } = require('../lib/util');

const PURPOSE_ENC = 'voucher-enc';
const PURPOSE_HASH = 'voucher-hash';

// eslint-disable-next-line no-control-regex
const VALID_CODE = /^[^\u0000-\u001f\u007f\s]{4,128}$/;

function normalizeCodes(rawList) {
  const seen = new Set();
  const valid = [];
  let invalid = 0;
  let duplicatesInInput = 0;
  for (const raw of rawList) {
    const code = String(raw).trim();
    if (!VALID_CODE.test(code)) {
      invalid += 1;
    } else if (seen.has(code)) {
      duplicatesInInput += 1;
    } else {
      seen.add(code);
      valid.push(code);
    }
  }
  return { valid, invalid, duplicatesInInput };
}

async function addCodes(rewardId, codes, adminId) {
  const docs = codes.map((code) => ({
    rewardId,
    codeEnc: encrypt(code, PURPOSE_ENC),
    codeHash: hmac(code, PURPOSE_HASH),
    last4: code.slice(-4),
    status: 'available',
    createdBy: adminId,
  }));
  let added = 0;
  try {
    const res = await VoucherCode.insertMany(docs, { ordered: false, rawResult: true });
    added = res.insertedCount;
  } catch (err) {
    // ordered:false keeps inserting after duplicate-key failures; count what landed.
    if (isDupKey(err) || (err.writeErrors && err.writeErrors.every((e) => e.err && e.err.code === 11000))) {
      added = (err.result && err.result.insertedCount) ?? (err.insertedDocs ? err.insertedDocs.length : 0);
    } else {
      throw err;
    }
  }
  return { added, duplicatesInDb: docs.length - added };
}

const revealCode = (voucher) => decrypt(voucher.codeEnc, PURPOSE_ENC);
const mask = (voucher) => `••••${voucher.last4}`;

module.exports = { normalizeCodes, addCodes, revealCode, mask };
