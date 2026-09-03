/**
 * Reports — read-only aggregation endpoints (mounted at /admin/reports).
 *
 * WHY THIS ROUTE FILE EXISTS
 *   constants/modules.js used to note that REPORTS "has no dedicated BE routes
 *   -- FE-only surfaces that compose other endpoints". That was true while the
 *   General Report composed the three property list endpoints client-side, and
 *   the General Report still does exactly that: it is untouched by this file.
 *
 *   The three CRM-backed sections cannot work that way. A row in those reports
 *   is a CRM lead joined to its property's classification and location and, for
 *   a deal, to its payment schedule. Composing that in the browser would mean
 *   paging the CRM list to exhaustion, then a per-lead property lookup, then a
 *   per-deal payment fetch - N+1 round-trips to rebuild a join the database can
 *   do once. It would also put the money on the client to add up, and the one
 *   thing the Financial Report must never do is compute its own totals.
 *
 * GATED ON MODULES.REPORTS, NOT CRM_MANAGEMENT
 *   This is the Reports surface, so it takes the Reports grant - matching the
 *   FE route guard on /admin/reports. Gating it on CRM_MANAGEMENT would mean a
 *   sub-admin granted Reports alone opened the page to three broken tabs.
 *   Administrators pass either way via requireModule's role short-circuit.
 *
 * READ-ONLY BY CONSTRUCTION
 *   Only GET verbs are declared here, and the service beneath performs no
 *   writes. The Financial Report's read-only requirement is therefore not a UI
 *   convention that a curl could step around: there is no write path to reach.
 *   Editing a deal stays where it was, behind the CRM module's own write gate.
 */

const express = require('express');

const { requireAuth, requireModule } = require('../../middleware/auth');
const { MODULES } = require('../../constants/modules');
const leadReports = require('../../services/crm/leadReports');

const router = express.Router();

router.use(requireAuth, requireModule(MODULES.REPORTS));

/**
 * The dataset behind Sold Property / Financial / Marketing.
 *
 * Returns every lead in one response. The client filters, charts and tabulates
 * it, and narrows its own dropdowns to the values actually present - which is
 * what makes the CRM filters dependent without a combination master.
 *
 * MAX_ROWS is a guard, not a page size. Truncating is reported on the response
 * (`truncated`) and the client says so, because a report that silently drops
 * rows is worse than one that admits it cannot show them all.
 */
const MAX_ROWS = 5000;

/**
 * `search` is optional and, when present, is applied in SQL through the same
 * clause the CRM listing uses. It cannot be done on the client: the response
 * masks name, mobile and email, so the words an operator actually types are not
 * in the payload at all.
 *
 * Trimmed and length-capped. The value is bound as a parameter, never
 * interpolated - see SEARCH_SQL in db/queries/crmLeadReports.js.
 */
const MAX_SEARCH = 200;

router.get('/crm-leads', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, MAX_SEARCH);
    res.json(await leadReports.list({ maxRows: MAX_ROWS, search }));
  } catch (e) { next(e); }
});

module.exports = router;
