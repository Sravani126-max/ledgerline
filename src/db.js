const { Pool, types } = require('pg');
// int8 -> JS number. Safe because every amount is capped well below 2^53 (see MAX_AMOUNT_PAISE).
types.setTypeParser(20, (v) => parseInt(v, 10));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  connectionString: url,
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
module.exports = pool;
