'use strict';

/**
 * Creates an admin account directly in the database (there is deliberately no public signup).
 *
 *   npm run create-admin                       -> interactive (password is typed hidden)
 *   npm run create-admin -- --role superadmin  -> choose role: viewer | admin | superadmin
 *   npm run create-admin -- --mfa              -> also set up an authenticator app right away
 *
 * Non-interactive (CI/provisioning): ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD env vars.
 * The password is hashed with bcrypt; the plaintext is never stored or logged.
 */
const readline = require('readline');
const QRCode = require('qrcode');
const { connectDb, disconnectDb } = require('../src/db');
const { Admin } = require('../src/models');
const { hashPassword, passwordProblem } = require('../src/services/adminAuth');
const { ADMIN_ROLES } = require('../src/constants');
const { encrypt } = require('../src/lib/crypto');
const totp = require('../src/lib/totp');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(s);
        else if (s === '\r\n' || s === '\n') process.stdout.write('\n');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const role = opt('role') || 'superadmin';
  if (!ADMIN_ROLES.includes(role)) throw new Error(`--role must be one of: ${ADMIN_ROLES.join(', ')}`);

  const email = (process.env.ADMIN_EMAIL || (await ask('Admin email: '))).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That does not look like an email address');
  const name = (process.env.ADMIN_NAME || (await ask('Display name: ')) || email.split('@')[0]).trim().slice(0, 100);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 12 chars, hidden): ', { hidden: true });
    const again = await ask('Repeat password: ', { hidden: true });
    if (password !== again) throw new Error('Passwords do not match');
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  await connectDb();
  if (await Admin.exists({ email })) throw new Error(`An admin with email ${email} already exists`);

  const doc = { email, name, role, passwordHash: await hashPassword(password) };
  let secret;
  if (flag('mfa')) {
    secret = totp.generateSecret();
    doc.mfaEnabled = true;
    doc.mfaSecretEnc = encrypt(secret, 'mfa');
  }
  await Admin.create(doc);
  console.log(`\nCreated ${role} "${email}".`);

  if (secret) {
    const url = totp.otpauthUrl({ secret, account: email, issuer: 'G Coin Rewards' });
    console.log('\nScan this QR code with your authenticator app (Google Authenticator, Authy, 1Password...):\n');
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(`Or enter this secret manually: ${secret}\nThis is shown only once.`);
  } else {
    console.log('Tip: sign in at /admin/ and enable MFA under Security (or re-run with --mfa).');
  }
}

main()
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
