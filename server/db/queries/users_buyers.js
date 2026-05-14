/**
 * Buyers aren't a separate accounts table — they're materialized from the
 * leads table. We aggregate by (mobile, email) since a single buyer might
 * reach out about multiple properties.
 */

const { pool } = require('../pool');

async function listAggregated({ page, pageSize, search, dateFrom, dateTo, sort }) {
  const where = ['l.deleted_at IS NULL'];
  const params = [];

  if (search) {
    where.push('(l.buyer_name LIKE ? OR l.buyer_mobile LIKE ? OR l.buyer_email LIKE ?)');
    const t = `%${search}%`;
    params.push(t, t, t);
  }
  if (dateFrom) { where.push('l.created_at >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(dateTo); }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const SORT = {
    'last_seen_at:desc': 'last_seen_at DESC',
    'last_seen_at:asc': 'last_seen_at ASC',
    'lead_count:desc': 'lead_count DESC, last_seen_at DESC',
    'name:asc': 'last_name ASC, last_seen_at DESC',
  };
  const orderSql = `ORDER BY ${SORT[sort] || SORT['last_seen_at:desc']}`;
  const offset = (page - 1) * pageSize;

  // Count of distinct buyers in the filtered subset.
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(DISTINCT CONCAT(l.buyer_mobile, '|', l.buyer_email)) AS total
     FROM leads l ${whereSql}`,
    params,
  );

  // Group and join the latest name observed for that buyer.
  const [rows] = await pool.query(
    `SELECT l.buyer_mobile AS mobile,
            l.buyer_email AS email,
            COUNT(*) AS lead_count,
            MAX(l.created_at) AS last_seen_at,
            MIN(l.created_at) AS first_seen_at,
            SUBSTRING_INDEX(GROUP_CONCAT(l.buyer_name ORDER BY l.created_at DESC SEPARATOR '|||~~|||'), '|||~~|||', 1) AS last_name,
            SUM(l.status = 'new') AS new_count,
            SUM(l.status = 'contacted') AS contacted_count
     FROM leads l
     ${whereSql}
     GROUP BY l.buyer_mobile, l.buyer_email
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

module.exports = { listAggregated };
