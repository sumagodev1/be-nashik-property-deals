#!/usr/bin/env node
/**
 * Seeds realistic demo data so the public website doesn't look empty.
 *
 * Inserts (idempotently — guards on uk_sellers_mobile and uk_website_property_code):
 *   - 10 sellers (mix of owner/agent), all verified+active
 *   - 24 approved + active website properties spread across types/transactions/localities
 *   - 12 leads against approved properties
 *   - 3 CMS banners (using external Unsplash URLs since we have no uploaded files)
 *
 * Usage: node scripts/seed-sample-data.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const NOW = () => new Date(Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000));

const SELLERS = [
  { mobile: '9000000001', name: 'Rajesh Kulkarni', email: 'rajesh.k@example.com', type: 'owner' },
  { mobile: '9000000002', name: 'Priya Deshmukh', email: 'priya.d@example.com', type: 'owner' },
  { mobile: '9000000003', name: 'Amit Patil', email: 'amit.p@example.com', type: 'owner' },
  { mobile: '9000000004', name: 'Sunita Joshi', email: 'sunita.j@example.com', type: 'owner' },
  { mobile: '9000000005', name: 'Vikram Nair', email: 'vikram.n@example.com', type: 'owner' },
  { mobile: '9000000006', name: 'Ravi Bhosale', email: 'ravi.b@example.com', type: 'agent', agency: 'Bhosale Realty', address: 'College Road, Nashik' },
  { mobile: '9000000007', name: 'Meera Pawar', email: 'meera.p@example.com', type: 'agent', agency: 'Nashik Estates', address: 'Gangapur Road, Nashik' },
  { mobile: '9000000008', name: 'Sanjay Wagh', email: 'sanjay.w@example.com', type: 'agent', agency: 'Wagh Properties', address: 'Dwarka, Nashik' },
  { mobile: '9000000009', name: 'Kavita Shinde', email: 'kavita.s@example.com', type: 'agent', agency: 'Shinde Realty', address: 'Satpur, Nashik' },
  { mobile: '9000000010', name: 'Mahesh Jagtap', email: 'mahesh.j@example.com', type: 'owner' },
];

const LOCATIONS = [
  'Gangapur Road, Nashik',
  'Nasik Road, Nashik',
  'College Road, Nashik',
  'Dwarka, Nashik',
  'Satpur, Nashik',
  'Ambad MIDC, Nashik',
  'Indira Nagar, Nashik',
  'Pathardi Phata, Nashik',
];

const PROPERTIES = [
  { title: 'Spacious 3BHK Flat with Modular Kitchen', type: 'flat', txn: 'sale', bhk: '3BHK', area: 1450, unit: 'sqft', price: 8500000, locIdx: 0, featured: true },
  { title: '2BHK Flat near College Road', type: 'flat', txn: 'sale', bhk: '2BHK', area: 1100, unit: 'sqft', price: 6200000, locIdx: 2, featured: false },
  { title: 'Modern 4BHK Apartment with Sky View', type: 'flat', txn: 'sale', bhk: '4BHK', area: 1850, unit: 'sqft', price: 12500000, locIdx: 0, featured: true },
  { title: 'Affordable 1BHK Flat for Rent', type: 'flat', txn: 'rent', bhk: '1BHK', area: 650, unit: 'sqft', price: 12000, locIdx: 1, featured: false },
  { title: '2BHK Furnished Flat — Long Term Lease', type: 'flat', txn: 'lease', bhk: '2BHK', area: 1050, unit: 'sqft', price: 1200000, locIdx: 3, featured: false },

  { title: 'Independent 3BHK House with Garden', type: 'house', txn: 'sale', bhk: '3BHK', area: 1800, unit: 'sqft', price: 11500000, locIdx: 1, featured: true },
  { title: 'Bungalow Style 4BHK House', type: 'house', txn: 'sale', bhk: '4BHK', area: 2400, unit: 'sqft', price: 18500000, locIdx: 3, featured: false },
  { title: '2BHK House on Quiet Lane', type: 'house', txn: 'rent', bhk: '2BHK', area: 1200, unit: 'sqft', price: 18000, locIdx: 6, featured: false },

  { title: 'Luxury 5BHK Villa with Pool', type: 'villa', txn: 'sale', bhk: '5BHK', area: 3200, unit: 'sqft', price: 32500000, locIdx: 3, featured: true },
  { title: 'Premium 4BHK Villa in Gated Community', type: 'villa', txn: 'sale', bhk: '4BHK', area: 2800, unit: 'sqft', price: 25500000, locIdx: 0, featured: true },
  { title: 'Hillside Villa with Panoramic View', type: 'villa', txn: 'sale', bhk: '4BHK', area: 2600, unit: 'sqft', price: 22500000, locIdx: 7, featured: false },

  { title: 'Residential Plot — Approved Layout', type: 'plot', txn: 'sale', bhk: null, area: 2400, unit: 'sqft', price: 4800000, locIdx: 4, featured: false },
  { title: 'Corner Plot Facing Main Road', type: 'plot', txn: 'sale', bhk: null, area: 3200, unit: 'sqft', price: 8400000, locIdx: 7, featured: true },
  { title: 'Investment Plot near MIDC', type: 'plot', txn: 'sale', bhk: null, area: 1800, unit: 'sqft', price: 3200000, locIdx: 5, featured: false },
  { title: 'Premium Plot in Gated Layout', type: 'plot', txn: 'sale', bhk: null, area: 2800, unit: 'sqft', price: 6500000, locIdx: 0, featured: false },

  { title: 'Commercial Shop on Main Market Road', type: 'commercial', txn: 'sale', bhk: null, area: 750, unit: 'sqft', price: 9500000, locIdx: 2, featured: true },
  { title: 'Office Space — Ready to Move', type: 'commercial', txn: 'rent', bhk: null, area: 1200, unit: 'sqft', price: 35000, locIdx: 5, featured: false },
  { title: 'Showroom Space with Frontage', type: 'commercial', txn: 'lease', bhk: null, area: 1800, unit: 'sqft', price: 2400000, locIdx: 0, featured: false },
  { title: 'Industrial Shed in MIDC', type: 'commercial', txn: 'sale', bhk: null, area: 4500, unit: 'sqft', price: 18500000, locIdx: 5, featured: false },

  { title: 'Agricultural Land — Fertile Soil', type: 'agricultural', txn: 'sale', bhk: null, area: 2, unit: 'acre', price: 4500000, locIdx: 7, featured: false },
  { title: 'Farmland with Borewell', type: 'agricultural', txn: 'sale', bhk: null, area: 3, unit: 'acre', price: 7500000, locIdx: 7, featured: false },

  { title: '1BHK Studio Apartment', type: 'flat', txn: 'rent', bhk: '1BHK', area: 550, unit: 'sqft', price: 9500, locIdx: 6, featured: false },
  { title: 'Newly Constructed 2BHK', type: 'flat', txn: 'sale', bhk: '2BHK', area: 950, unit: 'sqft', price: 5400000, locIdx: 1, featured: false },
  { title: 'Sea-view 3BHK Penthouse', type: 'flat', txn: 'sale', bhk: '3BHK', area: 1750, unit: 'sqft', price: 14500000, locIdx: 0, featured: true },
];

const LEAD_NAMES = [
  ['Sneha Gokhale', 'sneha.g@gmail.com', '9123456701'],
  ['Rohan Phadnis', 'rohan.p@gmail.com', '9123456702'],
  ['Anil Rane', 'anil.r@gmail.com', '9123456703'],
  ['Pooja Tambe', 'pooja.t@gmail.com', '9123456704'],
  ['Suresh Mahajan', 'suresh.m@gmail.com', '9123456705'],
  ['Deepika Salunkhe', 'deepika.s@gmail.com', '9123456706'],
  ['Kiran Borade', 'kiran.b@gmail.com', '9123456707'],
  ['Aarti Khopade', 'aarti.k@gmail.com', '9123456708'],
  ['Ganesh Patkar', 'ganesh.p@gmail.com', '9123456709'],
  ['Manisha Lokhande', 'manisha.l@gmail.com', '9123456710'],
  ['Tushar Kale', 'tushar.k@gmail.com', '9123456711'],
  ['Rupali Dhuri', 'rupali.d@gmail.com', '9123456712'],
];

const BANNERS = [
  {
    imageUrl: 'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&q=85',
    altText: 'Modern home interior',
    caption: 'Find Your Dream Property in Nashik',
    subcaption: 'Explore verified listings across every locality',
    sortOrder: 1,
  },
  {
    imageUrl: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=1600&q=85',
    altText: 'Luxury villa exterior',
    caption: 'Premium Homes at Best Prices',
    subcaption: 'Residential & commercial spaces across Nashik',
    sortOrder: 2,
  },
  {
    imageUrl: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1600&q=85',
    altText: 'Comfortable living room',
    caption: 'Invest Smart in Nashik Real Estate',
    subcaption: 'Connect with verified sellers, agents & owners',
    sortOrder: 3,
  },
];

function randomFromArray(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
    dateStrings: true,
    timezone: 'Z',
  });

  try {
    await conn.query("SET time_zone = '+00:00'");

    // 1) Sellers — keep existing rows, only insert missing
    const sellerIdByMobile = new Map();
    for (const s of SELLERS) {
      const [existing] = await conn.query(
        'SELECT id FROM sellers WHERE mobile_number = ? LIMIT 1',
        [s.mobile],
      );
      if (existing.length > 0) {
        sellerIdByMobile.set(s.mobile, existing[0].id);
        continue;
      }
      const [result] = await conn.query(
        `INSERT INTO sellers
           (user_type, full_name, mobile_number, email, agency_name, business_address, is_active, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [s.type, s.name, s.mobile, s.email, s.agency || null, s.address || null],
      );
      sellerIdByMobile.set(s.mobile, result.insertId);
    }
    console.log(`Sellers ready: ${sellerIdByMobile.size}`);

    // 2) Website properties — keyed by title for idempotency
    const sellerIds = [...sellerIdByMobile.values()];
    let propsInserted = 0;
    const insertedPropIds = [];
    for (let i = 0; i < PROPERTIES.length; i += 1) {
      const p = PROPERTIES[i];
      const [existing] = await conn.query(
        'SELECT id FROM website_properties WHERE property_code = ? LIMIT 1',
        [`WEB-DEMO${String(i + 1).padStart(3, '0')}`],
      );
      if (existing.length > 0) {
        insertedPropIds.push(existing[0].id);
        continue;
      }
      const code = `WEB-DEMO${String(i + 1).padStart(3, '0')}`;
      const location = LOCATIONS[p.locIdx];
      const sellerId = sellerIds[i % sellerIds.length];
      const desc = `${p.title}. Located in ${location}. Total area ${p.area} ${p.unit}.` +
        (p.bhk ? ` Configuration: ${p.bhk}.` : '') +
        ' Verified by Nashik Property Deals. Schedule a visit by clicking Contact Seller.';
      const createdAt = NOW();
      const approvedAt = createdAt;

      const [result] = await conn.query(
        `INSERT INTO website_properties
           (property_code, seller_id, title, description, property_type, transaction_type,
            location, area_value, area_unit, bhk, price,
            approval_status, is_active, is_featured, approved_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?, ?, ?)`,
        [
          code, sellerId, p.title, desc, p.type, p.txn,
          location, p.area, p.unit, p.bhk, p.price,
          p.featured ? 1 : 0, approvedAt, createdAt, createdAt,
        ],
      );
      insertedPropIds.push(result.insertId);
      propsInserted += 1;
    }
    console.log(`Website properties: ${propsInserted} new, ${insertedPropIds.length} total demo`);

    // 3) Leads — at least 12 across the inserted demo properties.
    const [[{ leadCount }]] = await conn.query(
      'SELECT COUNT(*) AS leadCount FROM leads WHERE deleted_at IS NULL',
    );
    if (leadCount < 12 && insertedPropIds.length > 0) {
      let leadsInserted = 0;
      for (const [name, email, mobile] of LEAD_NAMES) {
        const propId = randomFromArray(insertedPropIds);
        const action = Math.random() > 0.5 ? 'contact_seller' : 'view_location';
        await conn.query(
          `INSERT INTO leads
             (website_property_id, action_type, buyer_name, buyer_mobile, buyer_email, status)
           VALUES (?, ?, ?, ?, ?, 'new')`,
          [propId, action, name, mobile, email],
        );
        leadsInserted += 1;
      }
      console.log(`Leads inserted: ${leadsInserted}`);
    } else {
      console.log(`Leads already present: ${leadCount}`);
    }

    // 4) CMS banners — only insert if cms_banners is empty
    const [[{ bannerCount }]] = await conn.query(
      'SELECT COUNT(*) AS bannerCount FROM cms_banners',
    );
    if (bannerCount === 0) {
      for (const b of BANNERS) {
        await conn.query(
          `INSERT INTO cms_banners
             (image_url, alt_text, caption, subcaption, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [b.imageUrl, b.altText, b.caption, b.subcaption, b.sortOrder],
        );
      }
      console.log(`Banners inserted: ${BANNERS.length}`);
    } else {
      console.log(`Banners already present: ${bannerCount}`);
    }

    // 5) CMS settings (contact info) — only insert if not set
    const CMS_DEFAULTS = {
      contact_phone: '+91 98765 43210',
      contact_email: 'info@nashikpropertydeals.com',
      contact_address: 'Gangapur Road, Nashik – 422013, Maharashtra',
      social_facebook: 'https://facebook.com/nashikpropertydeals',
      social_instagram: 'https://instagram.com/nashikpropertydeals',
      social_whatsapp: 'https://wa.me/919876543210',
    };
    for (const [key, value] of Object.entries(CMS_DEFAULTS)) {
      await conn.query(
        'INSERT IGNORE INTO cms_settings (setting_key, setting_value) VALUES (?, ?)',
        [key, value],
      );
    }
    console.log('CMS settings ensured');

    console.log('\nSeed complete.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  console.error(err);
  process.exit(1);
});
