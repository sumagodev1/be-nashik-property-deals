const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nashik_property_deals',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: 0,
  dateStrings: true,
  timezone: 'Z',
});

// Force every connection in the pool to UTC. Without this, NOW() and stored
// DATETIMEs are interpreted in the server's local timezone, which breaks
// JS-computed expirations (we store ISO/UTC strings).
// The `connection` event hands us the raw (non-promise) connection — use the
// callback form so we don't end up awaiting a non-promise value.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", () => {});
});

async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}

module.exports = { pool, ping };
