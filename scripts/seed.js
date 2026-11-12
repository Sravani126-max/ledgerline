const pool = require('../src/db');
require('../src/seed').seed().then(() => { console.log('seeded'); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
