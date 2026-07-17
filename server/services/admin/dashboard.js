const dashboardRepo = require('../../db/queries/dashboard');

async function kpi() {
  return dashboardRepo.counters();
}

async function charts({ days = 30, granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const [
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    topAreas,
    topAreasWebsite,
    topAreasInventory,
    sellerOnboarding,
    sellersByArea,
  ] = await Promise.all([
    dashboardRepo.listingsByBucket({ granularity, dateFrom, dateTo }),
    dashboardRepo.listingsByPropertyType(),
    dashboardRepo.listingsByTransactionType(),
    dashboardRepo.topAreas({ limit: 10 }),
    dashboardRepo.topAreasWebsite({ limit: 10 }),
    dashboardRepo.topAreasInventory({ limit: 10 }),
    // Use the bucket version so weekly/monthly/custom granularity now applies
    // to the sellers chart too (was previously fixed at daily-30d).
    dashboardRepo.sellerOnboardingByBucket({ granularity, dateFrom, dateTo }),
    dashboardRepo.sellersByArea({ limit: 10 }),
  ]);
  return {
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    topAreas,
    topAreasWebsite,
    topAreasInventory,
    sellerOnboarding,
    sellersByArea,
    granularity,
    range: { days, dateFrom, dateTo },
  };
}

/* ──────────────────────────────────────────────────────────────────
 * Per-surface dashboards.
 *
 * Two isolated payloads so the admin panel can render one dashboard per
 * property surface (Website / Inventory) without any client-side
 * filtering. Data from the "other" surface is NEVER included.
 * ────────────────────────────────────────────────────────────────── */

async function websiteKpi() {
  return dashboardRepo.websiteCounters();
}

async function websiteCharts({ granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const [
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
  ] = await Promise.all([
    dashboardRepo.listingsByBucketSingle('website_properties', { granularity, dateFrom, dateTo }),
    dashboardRepo.listingsByPropertyTypeSingle('website_properties'),
    dashboardRepo.listingsByTransactionTypeSingle('website_properties'),
    dashboardRepo.listingsByPropertyVarietySingle('website_properties'),
    dashboardRepo.topAreasWebsite({ limit: 10 }),
  ]);
  return {
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
    granularity,
    range: { dateFrom, dateTo },
  };
}

async function inventoryKpi() {
  return dashboardRepo.inventoryCounters();
}

async function inventoryCharts({ granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const [
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
  ] = await Promise.all([
    dashboardRepo.listingsByBucketSingle('inventory_properties', { granularity, dateFrom, dateTo }),
    dashboardRepo.listingsByPropertyTypeSingle('inventory_properties'),
    dashboardRepo.listingsByTransactionTypeSingle('inventory_properties'),
    dashboardRepo.listingsByPropertyVarietySingle('inventory_properties'),
    dashboardRepo.topAreasInventory({ limit: 10 }),
  ]);
  return {
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
    granularity,
    range: { dateFrom, dateTo },
  };
}

async function enquiryKpi() {
  return dashboardRepo.enquiryCounters();
}

async function enquiryCharts({ granularity = 'daily', dateFrom = null, dateTo = null } = {}) {
  const [
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
  ] = await Promise.all([
    dashboardRepo.listingsByBucketSingle('enquiry_properties', { granularity, dateFrom, dateTo }),
    dashboardRepo.listingsByPropertyTypeSingle('enquiry_properties'),
    dashboardRepo.listingsByTransactionTypeSingle('enquiry_properties'),
    dashboardRepo.listingsByPropertyVarietySingle('enquiry_properties'),
    dashboardRepo.topAreasEnquiry({ limit: 10 }),
  ]);
  return {
    listingsOverTime,
    propertyTypeDistribution,
    transactionTypeDistribution,
    propertyVarietyDistribution,
    topAreas,
    granularity,
    range: { dateFrom, dateTo },
  };
}

module.exports = {
  kpi,
  charts,
  websiteKpi,
  websiteCharts,
  inventoryKpi,
  inventoryCharts,
  enquiryKpi,
  enquiryCharts,
};
