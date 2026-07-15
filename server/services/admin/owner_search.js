/**
 * Service layer for cross-module Owner Search.
 *
 * Fans the query out to inventory / enquiry / business_associates, normalises
 * each source into a common suggestion shape, groups rows that describe the
 * same person into a single suggestion with a `usages[]` list, and caps the
 * final response.
 *
 * Suggestion shape (returned as `data[]`):
 *   {
 *     id:          string    — stable de-dupe key ("inv-42" / "biz-7" / "person:<hash>")
 *     name:        string    — display name
 *     phone:       string    — primary phone chosen from phones/mobiles
 *     mobile:      string    — first mobile
 *     whatsapp:    string    — whatsapp (BA only)
 *     email:       string    — first email
 *     source:      'inventory' | 'enquiry' | 'business_associate'
 *     sourceLabel: 'Inventory' | 'Enquiry' | 'Business Associate'
 *     recordId:    number    — id in the source table (of the primary usage)
 *     propertyCode: string?  — e.g. "INV-2507-0005" (property sources only)
 *     propertyType: string?
 *     transactionType: string?
 *     transactionVariant: string?
 *     location:    string?
 *     designation: string?   — BA only
 *     cityCode:    string?   — BA only
 *     usages: Array<{
 *       source, sourceLabel, recordId,
 *       propertyCode?, propertyType?, transactionType?, location?,
 *       designation?, cityCode?
 *     }>
 *   }
 *
 * De-duplication key:
 *   Two rows describe the same person if their normalised name matches AND
 *   they share at least one normalised phone number. Fall back to the source
 *   row id otherwise (so unrelated records never collapse together).
 */

const repo = require('../../db/queries/owner_search');

const SOURCE_LABELS = {
  inventory: 'Inventory',
  enquiry: 'Enquiry',
  business_associate: 'Business Associate',
};

function normalisePhone(p) {
  if (!p) return '';
  return String(p).replace(/\D/g, '');
}

function normaliseName(n) {
  if (!n) return '';
  return String(n).trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ---------------------------------------------------------------
// Extract "candidate people" from a property row.
//
// A property row can carry multiple owner-like people:
//   - top-level owner_name / owner_contact (columns)
//   - details.contacts[]     — owner contact cards
//   - details.keyPersons[]   — key-person cards
//
// Each candidate becomes an independent suggestion (later de-duped by the
// caller). Returning multiple per row means a match on "Keshav" in a
// secondary contact still surfaces even though the top-level owner is
// someone else.
// ---------------------------------------------------------------
function extractPropertyCandidates(row, source) {
  const out = [];
  const base = {
    source,
    sourceLabel: SOURCE_LABELS[source],
    recordId: row.id,
    propertyCode: row.property_code || '',
    propertyType: row.property_type || '',
    transactionType: row.transaction_type || '',
    transactionVariant: row.transaction_variant || '',
    location: row.location || '',
  };

  // Top-level columns.
  if (row.owner_name || row.owner_contact) {
    out.push({
      ...base,
      name: row.owner_name || '',
      phone: row.owner_contact || '',
      mobile: row.owner_contact || '',
      whatsapp: '',
      email: '',
    });
  }

  // details JSON — may be a JS object (mysql2 auto-parses JSON columns) or a
  // string on older MySQL versions. Guard both shapes.
  let details = row.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  if (!details || typeof details !== 'object') return out;

  const collectPeople = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      const name = firstNonEmpty(c.name);
      const phone = firstNonEmpty(...(Array.isArray(c.phones) ? c.phones : []));
      const mobile = firstNonEmpty(...(Array.isArray(c.mobiles) ? c.mobiles : []));
      const email = firstNonEmpty(...(Array.isArray(c.emails) ? c.emails : []));
      if (!name && !phone && !mobile && !email) continue;
      out.push({
        ...base,
        name,
        phone: phone || mobile,
        mobile,
        whatsapp: '',
        email,
      });
    }
  };

  // Handle both the nested-under-dynamicData shape (as written by the MD form)
  // and the flat shape (older / non-MD forms).
  const dyn = details.dynamicData && typeof details.dynamicData === 'object'
    ? details.dynamicData
    : details;
  collectPeople(dyn.contacts);
  collectPeople(dyn.keyPersons);

  return out;
}

function buildBaFullName(row) {
  const parts = [row.first_name, row.middle_name, row.surname]
    .map((v) => (v ? String(v).trim() : ''))
    .filter(Boolean);
  return parts.join(' ');
}

function baseCandidateFromBa(row) {
  return {
    source: 'business_associate',
    sourceLabel: SOURCE_LABELS.business_associate,
    recordId: row.id,
    name: buildBaFullName(row),
    phone: firstNonEmpty(row.mobile1, row.phone1, row.mobile2, row.mobile3, row.whatsapp),
    mobile: firstNonEmpty(row.mobile1, row.mobile2, row.mobile3),
    whatsapp: row.whatsapp || '',
    email: firstNonEmpty(row.email1, row.email2),
    designation: row.designation || '',
    cityCode: row.city_code || '',
  };
}

// ---------------------------------------------------------------
// Filter a candidate against the raw query. LIKE at the DB layer already
// bounds the initial row set, but a property row may have matched only
// because of the `details LIKE` scan — so a candidate person on that same
// row who doesn't personally match the query would leak through. Second
// pass here ensures every emitted suggestion is genuinely relevant.
// ---------------------------------------------------------------
function candidateMatches(cand, q) {
  const qLower = q.toLowerCase();
  const qDigits = normalisePhone(q);
  const nameHit = cand.name && cand.name.toLowerCase().includes(qLower);
  const designationHit = cand.designation
    && cand.designation.toLowerCase().includes(qLower);
  const emailHit = cand.email && cand.email.toLowerCase().includes(qLower);
  if (nameHit || designationHit || emailHit) return true;
  if (!qDigits) return false;
  const phoneFields = [cand.phone, cand.mobile, cand.whatsapp];
  return phoneFields.some((p) => p && normalisePhone(p).includes(qDigits));
}

// ---------------------------------------------------------------
// De-duplication key. Rule of thumb: two candidates collapse together when
// their normalised name matches (aggressive by design — the UI shows every
// usage so the admin can spot false merges at a glance, and the alternative
// of splitting the same-named person across every property they own is much
// more confusing). Nameless candidates fall back to phone or record id.
//
// Property rows always keep their own recordId as a fallback key so two
// distinct properties owned by the same person still show up as separate
// USAGES (via the usages[] list) — they just merge into one suggestion.
// ---------------------------------------------------------------
function dedupeKey(cand) {
  const name = normaliseName(cand.name);
  const phone = normalisePhone(cand.phone || cand.mobile || cand.whatsapp);
  if (name) return `n:${name}`;
  if (phone) return `p:${phone}`;
  return `r:${cand.source}:${cand.recordId}`;
}

async function search(q, sources = ['inventory', 'enquiry', 'ba'], limit = 15) {
  const query = String(q || '').trim();
  if (query.length < 2) return { data: [], meta: { total: 0, q: query } };

  const wantInv = sources.includes('inventory');
  const wantEnq = sources.includes('enquiry');
  const wantBa  = sources.includes('ba') || sources.includes('business_associate');

  const [invRows, enqRows, baRows] = await Promise.all([
    wantInv ? repo.searchInventory(query)          : Promise.resolve([]),
    wantEnq ? repo.searchEnquiry(query)            : Promise.resolve([]),
    wantBa  ? repo.searchBusinessAssociates(query) : Promise.resolve([]),
  ]);

  const allCandidates = [];
  for (const row of invRows) {
    for (const c of extractPropertyCandidates(row, 'inventory')) allCandidates.push(c);
  }
  for (const row of enqRows) {
    for (const c of extractPropertyCandidates(row, 'enquiry')) allCandidates.push(c);
  }
  for (const row of baRows) {
    allCandidates.push(baseCandidateFromBa(row));
  }

  // Filter each candidate against the query (see comment above).
  const relevant = allCandidates.filter((c) => candidateMatches(c, query));

  // Group by de-dupe key. Each group becomes one suggestion — the first
  // candidate is the primary, subsequent ones become entries in `usages[]`.
  const groups = new Map();
  for (const cand of relevant) {
    const key = dedupeKey(cand);
    if (!groups.has(key)) {
      groups.set(key, {
        primary: cand,
        usages: [],
      });
    }
    const g = groups.get(key);
    // Every candidate — including the primary — is also a usage. This makes
    // the UI's "Used In" list complete without special-casing the first entry.
    g.usages.push({
      source: cand.source,
      sourceLabel: cand.sourceLabel,
      recordId: cand.recordId,
      propertyCode: cand.propertyCode,
      propertyType: cand.propertyType,
      transactionType: cand.transactionType,
      transactionVariant: cand.transactionVariant,
      location: cand.location,
      designation: cand.designation,
      cityCode: cand.cityCode,
    });
    // Promote richer contact info from later candidates into the primary
    // whenever the primary is missing a field but the newer one has it.
    // (Property rows often have only a phone; a matching BA record may
    // provide the whatsapp / email that fills in the primary display.)
    for (const key of ['whatsapp', 'email', 'mobile', 'phone', 'designation', 'cityCode']) {
      if (!g.primary[key] && cand[key]) g.primary[key] = cand[key];
    }
    // If the primary's source is 'inventory' but this candidate is a BA,
    // don't overwrite the primary source — the primary reflects the most
    // recently created hit's source, which is usually good enough. Callers
    // read `usages[]` when they need per-source detail.
  }

  const suggestions = Array.from(groups.values()).map(({ primary, usages }) => {
    const dedupedUsages = [];
    const seen = new Set();
    for (const u of usages) {
      const k = `${u.source}:${u.recordId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedupedUsages.push(u);
    }
    return {
      id: dedupeKey(primary),
      name: primary.name,
      phone: primary.phone,
      mobile: primary.mobile,
      whatsapp: primary.whatsapp,
      email: primary.email,
      source: primary.source,
      sourceLabel: primary.sourceLabel,
      recordId: primary.recordId,
      propertyCode: primary.propertyCode || '',
      propertyType: primary.propertyType || '',
      transactionType: primary.transactionType || '',
      transactionVariant: primary.transactionVariant || '',
      location: primary.location || '',
      designation: primary.designation || '',
      cityCode: primary.cityCode || '',
      usages: dedupedUsages,
    };
  });

  const trimmed = suggestions.slice(0, Math.max(1, Math.min(limit, 50)));

  return {
    data: trimmed,
    meta: { total: trimmed.length, q: query },
  };
}

module.exports = { search };
