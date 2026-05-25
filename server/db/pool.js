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
  timezone: 'Z',
  // DATETIME / TIMESTAMP columns are returned as ISO-8601 strings with an
  // explicit 'Z' suffix (e.g. "2026-05-23T06:14:00Z") instead of mysql2's
  // default bare "YYYY-MM-DD HH:MM:SS" format. The bare format has no
  // timezone marker, which causes `new Date(value)` in browsers / Node to
  // parse it as LOCAL time and silently drop the actual UTC offset — so a
  // lead created at 11:34 IST (06:04 UTC) was rendering on the admin panel
  // as "06:04 AM" instead of "11:34 AM". DATE columns (no time component)
  // are still returned as the plain "YYYY-MM-DD" string.
  dateStrings: false,
  typeCast(field, next) {
    if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
      const raw = field.string();
      if (raw == null) return null;
      // MySQL: "YYYY-MM-DD HH:MM:SS[.ffffff]" → ISO-8601 UTC.
      return raw.replace(' ', 'T') + 'Z';
    }
    if (field.type === 'DATE') {
      return field.string();
    }
    return next();
  },
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
