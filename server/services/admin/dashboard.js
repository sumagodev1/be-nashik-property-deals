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

module.exports = { kpi, charts };
