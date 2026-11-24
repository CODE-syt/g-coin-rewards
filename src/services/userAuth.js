'use strict';

const { User } = require('../models');
const { SIGNUP_BONUS } = require('../constants');
const { cleanText, isDupKey } = require('../lib/util');
const { recordTx } = require('./ledger');

async function upsertUser({ sub, email, name, picture }) {
  const set = {
    email: String(email).toLowerCase().trim(),
    name: cleanText(name || email.split('@')[0], 200) || 'G Coin member',
    picture: /^https:\/\//i.test(picture || '') ? String(picture).slice(0, 1000) : '',
    lastLoginAt: new Date(),
  };
  const run = () => User.findOneAndUpdate({ googleId: sub }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
  try {
    return await run();
  } catch (err) {
    // Two first-ever sign-ins racing: the loser hits the unique index and simply re-reads.
    if (isDupKey(err)) return run();
    throw err;
  }
}

/**
 * Signs a verified Google identity in. Creates the user on first sign-in and grants the
 * one-time signup bonus. The bonus is guarded by an atomic conditional update
 * (signupBonusGranted != true) and a unique ledger key, so retries, double-clicks and
 * concurrent logins can never grant it twice.
 */
async function signInWithGoogleProfile(profile) {
  const user = await upsertUser(profile);

  const claimed = await User.findOneAndUpdate(
    { _id: user._id, signupBonusGranted: { $ne: true } },
    { $set: { signupBonusGranted: true, signupBonusAt: new Date() }, $inc: { coinBalance: SIGNUP_BONUS } },
    { new: true }
  );

  if (claimed) {
    await recordTx({
      userId: claimed._id,
      type: 'signup_bonus',
      amount: SIGNUP_BONUS,
      balanceAfter: claimed.coinBalance,
      description: 'Welcome bonus',
      refType: 'user',
      refId: claimed._id,
      idempotencyKey: `signup:${claimed._id}`,
    });
    return { user: claimed, isNew: true, bonusGranted: SIGNUP_BONUS };
  }
  const fresh = await User.findById(user._id);
  return { user: fresh, isNew: false, bonusGranted: 0 };
}

const toUserDto = (u) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  picture: u.picture || '',
  balance: u.coinBalance,
  createdAt: u.createdAt,
});

module.exports = { signInWithGoogleProfile, toUserDto };
