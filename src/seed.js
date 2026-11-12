const bcrypt = require('bcryptjs');
const pool = require('./db');

// Idempotent: safe to run on every deploy.
async function seed({ demo = true } = {}) {
  await pool.query(`INSERT INTO accounts(name, is_external) SELECT 'EXTERNAL (bank counterparty)', true WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE is_external)`);
  if (!demo) return;
  const pw = process.env.DEMO_PASSWORD || 'LedgerLine#2026';
  const hash = await bcrypt.hash(pw, 10);
  const users = [['admin@ledgerline.test', 'admin'], ['holder1@ledgerline.test', 'holder'], ['holder2@ledgerline.test', 'holder'], ['auditor@ledgerline.test', 'auditor']];
  for (const [email, role] of users)
    await pool.query('INSERT INTO users(email,password_hash,role) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING', [email, hash, role]);
  for (const [email, name] of [['holder1@ledgerline.test', 'Holder 1 - Current'], ['holder2@ledgerline.test', 'Holder 2 - Current']])
    await pool.query(`INSERT INTO accounts(name, owner_id) SELECT $2, id FROM users WHERE email=$1 AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.owner_id=users.id)`, [email, name]);
}
module.exports = { seed };
