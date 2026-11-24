'use strict';

module.exports = Object.freeze({
  APP_NAME: 'G Coin Rewards',
  CURRENCY_NAME: 'G Coins',
  // These two values are product rules, not deployment settings. They are
  // constants on purpose so the "exactly 5 coins" rule cannot drift per environment.
  SIGNUP_BONUS: 5,
  SHARE_BONUS: 5,
  LOW_STOCK_THRESHOLD: 5,
  TX_TYPES: ['signup_bonus', 'share_bonus', 'redemption'],
  VOUCHER_MODES: ['reveal', 'hidden', 'none'],
  ADMIN_ROLES: ['viewer', 'admin', 'superadmin'],
  ROLE_RANK: { viewer: 1, admin: 2, superadmin: 3 },
});
