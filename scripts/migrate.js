// Applies db/schema.sql once. Re-running is a no-op if the schema exists.
const fs = require('fs'); const path = require('path');
const pool = require('../src/db');
(async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (!rows[0].t) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    console.log('schema applied');
  } else console.log('schema already present');
  await require('../src/seed').seed({ demo: process.env.SEED_DEMO !== 'false' });
  console.log('seed ok');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
