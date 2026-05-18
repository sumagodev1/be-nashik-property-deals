const { pool } = require('../pool');

async function publicCounters() {
  const [[website]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL AND approval_status = 'approved' AND is_active = 1) AS live_listings
    FROM website_properties
  `);

  const [[seller]] = await pool.query(`
    SELECT
      SUM(deleted_at IS NULL AND is_verified = 1 AND is_active = 1) AS verified_sellers
    FROM sellers
  `);

  const [[leads]] = await pool.query(`
    SELECT SUM(deleted_at IS NULL) AS total_leads FROM leads
  `);

  const [[localities]] = await pool.query(`
    SELECT COUNT(DISTINCT TRIM(location)) AS total_localities
    FROM website_properties
    WHERE deleted_at IS NULL
      AND approval_status = 'approved'
      AND is_active = 1
      AND location IS NOT NULL
      AND TRIM(location) <> ''
  `);

  return {
    liveListings: Number(website.live_listings || 0),
    verifiedSellers: Number(seller.verified_sellers || 0),
    totalLeads: Number(leads.total_leads || 0),
    totalLocalities: Number(localities.total_localities || 0),
  };
}

async function propertyTypeCounts() {
  const [rows] = await pool.query(`
    SELECT property_type, COUNT(*) AS count
    FROM website_properties
    WHERE deleted_at IS NULL
      AND approval_status = 'approved'
      AND is_active = 1
    GROUP BY property_type
  `);
  const out = {};
  for (const r of rows) out[r.property_type] = Number(r.count);
  return out;
}

module.exports = { publicCounters, propertyTypeCounts };
