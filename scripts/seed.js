/**
 * scripts/seed.js
 * ───────────────────────────────────────────────────────────────────────
 * ডেমো অ্যাকাউন্ট তৈরি করে (idempotent — বারবার চালালে ডুপ্লিকেট হবে না)।
 *
 *   npm run seed
 *
 * তৈরি করা অ্যাকাউন্ট (পিন: SEED_DEMO_PIN বা nexa1234):
 *   +8801700000001 — Rahim
 *   +8801700000002 — Karim
 *   +8801700000003 — Nusrat
 *
 * এরা একে অপরকে খুঁজে পাবে, চ্যাট ও কল করতে পারবে — ডেমো/টেস্টের জন্য।
 */

'use strict';

require('../src/config'); // dotenv লোড
const bcrypt = require('bcryptjs');
const { initDatabase, getDb, closeDatabase } = require('../database');

const DEMO_USERS = [
  { phone: '+8801700000001', name: 'Rahim', about: 'Hey there! I use NexaChat.' },
  { phone: '+8801700000002', name: 'Karim', about: 'Available' },
  { phone: '+8801700000003', name: 'Nusrat', about: '🌟 চ্যাট করি' }
];

async function main() {
  await initDatabase();
  const db = getDb();

  const pin = process.env.SEED_DEMO_PIN || 'nexa1234';
  const passwordHash = await bcrypt.hash(pin, 10);

  let created = 0;
  let skipped = 0;

  for (const user of DEMO_USERS) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await db.users.findByPhone(user.phone);
    if (existing) {
      skipped += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await db.users.create({
      phone: user.phone,
      name: user.name,
      passwordHash,
      about: user.about,
      avatar: null
    });
    created += 1;
    // eslint-disable-next-line no-console
    console.log(`  + created ${user.name} (${user.phone})`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nSeed complete: ${created} created, ${skipped} already existed.`);
  // eslint-disable-next-line no-console
  console.log(`Login PIN for all demo accounts: ${pin}`);

  await closeDatabase();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exit(1);
});
