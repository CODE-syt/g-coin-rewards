'use strict';

/**
 * Seeds example rewards (and clearly fake demo voucher codes). Safe to run repeatedly:
 * rewards are matched by a seedKey, and existing codes are never duplicated.
 *
 *   npm run seed            -> create/refresh example rewards
 *   npm run seed -- --reset -> first remove the seeded rewards and their codes
 */
const crypto = require('crypto');
const { connectDb, disconnectDb } = require('../src/db');
const { Reward, VoucherCode } = require('../src/models');
const { normalizeCodes, addCodes } = require('../src/services/vouchers');

const REWARDS = [
  { seedKey: 'coffee', name: 'Coffee Shop Coupon', price: 5, voucherMode: 'reveal', codes: 12, sortOrder: 1, imageUrl: '/img/rewards/coffee.svg',
    description: 'A free regular coffee at any participating campus cafe.',
    redemptionDetails: 'Show the code at the counter before ordering. One code per drink. Valid for 30 days after redemption.' },
  { seedKey: 'sticker', name: 'G Coin Sticker Pack', price: 5, voucherMode: 'none', stock: null, perUserLimit: 2, sortOrder: 2, imageUrl: '/img/rewards/sticker.svg',
    description: 'A pack of 6 glossy G Coin stickers for your laptop or bottle.',
    redemptionDetails: 'Collect your pack from the rewards desk (Mon-Fri, 10am-4pm). Show this redemption on your phone.' },
  { seedKey: 'movie', name: 'Movie Night Voucher', price: 10, voucherMode: 'reveal', codes: 8, sortOrder: 3, imageUrl: '/img/rewards/movie.svg',
    description: '20% off one movie ticket at partner cinemas.',
    redemptionDetails: 'Enter the code at checkout on the partner cinema site. Not valid on premieres or with other offers.' },
  { seedKey: 'music', name: 'Music Streaming - 1 Month', price: 15, voucherMode: 'reveal', codes: 4, sortOrder: 4, imageUrl: '/img/rewards/music.svg',
    description: 'One month of ad-free music streaming for new subscribers.',
    redemptionDetails: 'Redeem the code in the streaming app under Settings > Redeem. New accounts only.' },
  { seedKey: 'food', name: 'Food Delivery Rs.100 Off', price: 20, voucherMode: 'reveal', codes: 3, sortOrder: 5, imageUrl: '/img/rewards/food.svg',
    description: 'Rs.100 off your next food delivery order above Rs.299.',
    redemptionDetails: 'Apply the code at checkout. Valid for 14 days after redemption.' },
  { seedKey: 'course', name: 'Online Course Access', price: 25, voucherMode: 'hidden', codes: 5, sortOrder: 6, imageUrl: '/img/rewards/course.svg',
    description: 'Access to one self-paced online course of your choice from our partner catalog.',
    redemptionDetails: 'No code is shown here. Our team emails your course access to your sign-in address within 2 working days.' },
  { seedKey: 'notebook', name: 'Notebook & Pen Set', price: 30, voucherMode: 'none', stock: 25, perUserLimit: 1, sortOrder: 7, imageUrl: '/img/rewards/notebook.svg',
    description: 'A hardcover A5 notebook with a matching gel pen.',
    redemptionDetails: 'Collect from the rewards desk within 14 days. Limited stock.' },
  { seedKey: 'hoodie', name: 'Limited Edition Hoodie', price: 100, voucherMode: 'none', stock: 3, perUserLimit: 1, sortOrder: 8, imageUrl: '/img/rewards/hoodie.svg',
    description: 'Soft fleece hoodie with the embroidered G Coin logo. Only 3 made.',
    redemptionDetails: 'Choose your size at the rewards desk when you collect it.' },
  { seedKey: 'seasonal', name: 'Seasonal Special (not live yet)', price: 40, voucherMode: 'none', stock: 10, status: 'inactive', sortOrder: 9, imageUrl: '/img/rewards/seasonal.svg',
    description: 'An example of an inactive reward that customers cannot see.',
    redemptionDetails: 'Activate it from the admin panel when you are ready.' },
];

const demoCode = (prefix) => `DEMO-${prefix.toUpperCase().slice(0, 4)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

async function main() {
  await connectDb();
  if (process.argv.includes('--reset')) {
    const seeded = await Reward.find({ seedKey: { $exists: true } }).select('_id').lean();
    await VoucherCode.deleteMany({ rewardId: { $in: seeded.map((r) => r._id) } });
    await Reward.deleteMany({ _id: { $in: seeded.map((r) => r._id) } });
    console.log(`Removed ${seeded.length} seeded rewards.`);
  }

  for (const { codes, ...def } of REWARDS) {
    const reward = await Reward.findOneAndUpdate(
      { seedKey: def.seedKey },
      { $setOnInsert: { ...def, status: def.status || 'active', stock: def.stock ?? null, perUserLimit: def.perUserLimit ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (codes) {
      const existing = await VoucherCode.countDocuments({ rewardId: reward._id });
      if (existing < codes) {
        const { valid } = normalizeCodes(Array.from({ length: codes - existing }, () => demoCode(def.seedKey)));
        await addCodes(reward._id, valid);
      }
    }
    console.log(`  ${reward.name}`);
  }
  console.log('\nSeed complete. Voucher codes are fake DEMO-... values for testing only.');
}

main()
  .catch((err) => {
    console.error(`\nSeed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
