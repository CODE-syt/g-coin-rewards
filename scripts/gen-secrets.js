'use strict';

// Prints fresh random values for the secrets in .env. Nothing is written to disk.
const crypto = require('crypto');

console.log('# Paste these into your .env (generate new ones for each environment)');
console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
console.log(`DATA_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log('\n# Keep DATA_ENCRYPTION_KEY safe and backed up: voucher codes and MFA secrets are encrypted with it.');
console.log('# If it is lost, stored voucher codes cannot be recovered.');
