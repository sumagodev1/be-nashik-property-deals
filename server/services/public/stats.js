const queries = require('../../db/queries/public_stats');
const { PROPERTY_TYPES } = require('../../constants/property');

async function publicStats() {
  const [counters, typeCounts] = await Promise.all([
    queries.publicCounters(),
    queries.propertyTypeCounts(),
  ]);

  const propertyTypeCounts = {};
  for (const code of PROPERTY_TYPES) {
    propertyTypeCounts[code] = typeCounts[code] || 0;
  }

  return {
    liveListings: counters.liveListings,
    verifiedSellers: counters.verifiedSellers,
    totalLeads: counters.totalLeads,
    totalLocalities: counters.totalLocalities,
    propertyTypeCounts,
  };
}

module.exports = { publicStats };
