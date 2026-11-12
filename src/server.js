const app = require('./app');
const pool = require('./db');
const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`LedgerLine listening on ${port}`));
process.on('SIGTERM', () => server.close(() => pool.end()));
