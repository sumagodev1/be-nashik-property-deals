-- ============================================================
-- 073 — Global "Location" master seed
-- ============================================================
-- Introduces ONE reusable GLOBAL master vocabulary `location`, used as the
-- searchable dropdown for the "Location" field (formerly "Location with
-- Landmark Required") on the ENQUIRY registration forms — the dualMode
-- "Specific" side. Mirrors the `project_name` master (migration 072).
--
-- Design notes:
--   • GLOBAL scope (label prefixed "Global /"), mirroring `property_variety`
--     (054) and `project_name` (072). Do NOT create per-family duplicates.
--   • Admin-curated + grown over time via the master admin UI + the in-form
--     "Other → Save" flow (POST /admin/masters/location). This migration
--     seeds the initial Nashik-area locality vocabulary supplied by the
--     client so the dropdown is populated on a fresh install.
--   • Registration (what makes the key "managed" / visible in the Masters
--     admin + accepted by the master CRUD + public dropdown APIs) happens in
--     server/services/masters/management.js (LOOKUP_KEYS + MASTER_LABELS) —
--     rows alone are NOT sufficient. See migration 055's / 072's note.
--   • INSERT IGNORE against the (master_key, code) unique key → idempotent;
--     safe to re-run. Existing rows are preserved.
--   • The Enquiry location value persists (unchanged storage contract) as the
--     dualMode { specific, any } object in details.dynamicData.location, whose
--     `specific` side now stores the master LABEL (e.g. "College Road") — a
--     STRING, exactly as the pre-existing free-text values were. Legacy
--     free-text locations not present in this vocabulary keep loading +
--     displaying as-is (stale-value fallback in the dropdown).
--
-- NOTE on count: the client seed list enumerates 99 distinct localities
-- (the task's "97" was a miscount of the same list). All 99 are seeded
-- verbatim; each produces a unique code.
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('location', 'abhiyanta-nagar', 'Abhiyanta Nagar', 10, 1),
  ('location', 'adgaon', 'Adgaon', 20, 1),
  ('location', 'ambad', 'Ambad', 30, 1),
  ('location', 'ambedkar-nagar', 'Ambedkar Nagar', 40, 1),
  ('location', 'amritdham', 'Amritdham', 50, 1),
  ('location', 'anand-nagar', 'Anand Nagar', 60, 1),
  ('location', 'ashoka-marg', 'Ashoka Marg', 70, 1),
  ('location', 'bajarangwadi', 'Bajarangwadi', 80, 1),
  ('location', 'bhabha-nagar', 'Bhabha Nagar', 90, 1),
  ('location', 'bhujbal-farm', 'Bhujbal Farm', 100, 1),
  ('location', 'bodhale-nagar', 'Bodhale Nagar', 110, 1),
  ('location', 'canada-corner', 'Canada Corner', 120, 1),
  ('location', 'chandak-circle', 'Chandak Circle', 130, 1),
  ('location', 'chehdi', 'Chehdi', 140, 1),
  ('location', 'chetna-nagar', 'Chetna Nagar', 150, 1),
  ('location', 'cidco', 'Cidco', 160, 1),
  ('location', 'college-road', 'College Road', 170, 1),
  ('location', 'dasak', 'Dasak', 180, 1),
  ('location', 'datta-mandir', 'Datta Mandir', 190, 1),
  ('location', 'deepali-nagar', 'Deepali Nagar', 200, 1),
  ('location', 'deolali-camp', 'Deolali Camp', 210, 1),
  ('location', 'deolaligaon', 'Deolaligaon', 220, 1),
  ('location', 'dgp-nagar-no-1', 'DGP Nagar No.1', 230, 1),
  ('location', 'dgp-nagar-no-2', 'DGP Nagar No.2', 240, 1),
  ('location', 'dgp-nagar-no-3', 'DGP Nagar No.3', 250, 1),
  ('location', 'd-souza-colony', 'D''Souza Colony', 260, 1),
  ('location', 'dwarka', 'Dwarka', 270, 1),
  ('location', 'gandharva-nagari', 'Gandharva Nagari', 280, 1),
  ('location', 'gandhi-nagar', 'Gandhi Nagar', 290, 1),
  ('location', 'gangapur-road', 'Gangapur Road', 300, 1),
  ('location', 'gosavi-wadi', 'Gosavi Wadi', 310, 1),
  ('location', 'gulmohar-colony', 'Gulmohar Colony', 320, 1),
  ('location', 'hirawadi', 'Hirawadi', 330, 1),
  ('location', 'holaram-colony', 'Holaram Colony', 340, 1),
  ('location', 'indira-nagar', 'Indira Nagar', 350, 1),
  ('location', 'jai-bhawani-road', 'Jai Bhawani Road', 360, 1),
  ('location', 'jail-road', 'Jail Road', 370, 1),
  ('location', 'kala-nagar', 'Kala Nagar', 380, 1),
  ('location', 'kalpataru-nagar', 'Kalpataru Nagar', 390, 1),
  ('location', 'kamatwade', 'Kamatwade', 400, 1),
  ('location', 'kathe-galli', 'Kathe Galli', 410, 1),
  ('location', 'kedar-nagar', 'Kedar Nagar', 420, 1),
  ('location', 'khutwad-nagar', 'Khutwad Nagar', 430, 1),
  ('location', 'lam-road', 'Lam Road', 440, 1),
  ('location', 'lokmanya-nagar', 'Lokmanya Nagar', 450, 1),
  ('location', 'mahatma-nagar', 'Mahatma Nagar', 460, 1),
  ('location', 'makhamalabad', 'Makhamalabad', 470, 1),
  ('location', 'meri', 'Meri', 480, 1),
  ('location', 'mhasrool', 'Mhasrool', 490, 1),
  ('location', 'model-colony', 'Model Colony', 500, 1),
  ('location', 'narayan-bapu-nagar', 'Narayan Bapu Nagar', 510, 1),
  ('location', 'nashik-road', 'Nashik Road', 520, 1),
  ('location', 'nehru-nagar', 'Nehru Nagar', 530, 1),
  ('location', 'new-pandit-colony', 'New Pandit Colony', 540, 1),
  ('location', 'old-gangapur-naka', 'Old Gangapur Naka', 550, 1),
  ('location', 'ozhar', 'Ozhar', 560, 1),
  ('location', 'p-and-t-colony', 'P & T Colony', 570, 1),
  ('location', 'palse', 'Palse', 580, 1),
  ('location', 'panchak', 'Panchak', 590, 1),
  ('location', 'panchavati', 'Panchavati', 600, 1),
  ('location', 'pandavleni', 'Pandavleni', 610, 1),
  ('location', 'pathardi', 'Pathardi', 620, 1),
  ('location', 'pathardi-phata', 'Pathardi Phata', 630, 1),
  ('location', 'pathardi-devlali-road', 'Pathardi-Devlali Road', 640, 1),
  ('location', 'pavan-nagar', 'Pavan Nagar', 650, 1),
  ('location', 'pinto-colony', 'Pinto Colony', 660, 1),
  ('location', 'prashant-nagar', 'Prashant Nagar', 670, 1),
  ('location', 'racca-colony', 'Racca Colony', 680, 1),
  ('location', 'rajiv-nagar', 'Rajiv Nagar', 690, 1),
  ('location', 'rameshwar-nagar', 'Rameshwar Nagar', 700, 1),
  ('location', 'rane-nagar', 'Rane Nagar', 710, 1),
  ('location', 'rathacharkra-society', 'Rathacharkra Society', 720, 1),
  ('location', 'sadashiv-nagar', 'Sadashiv Nagar', 730, 1),
  ('location', 'sadguru-nagar', 'Sadguru Nagar', 740, 1),
  ('location', 'samata-nagar', 'Samata Nagar', 750, 1),
  ('location', 'satpur', 'Satpur', 760, 1),
  ('location', 'satpur-midc', 'Satpur MIDC', 770, 1),
  ('location', 'shalimar', 'Shalimar', 780, 1),
  ('location', 'shankar-nagar', 'Shankar Nagar', 790, 1),
  ('location', 'shanti-park', 'Shanti Park', 800, 1),
  ('location', 'sharanpur-road', 'Sharanpur Road', 810, 1),
  ('location', 'shikrewadi', 'Shikrewadi', 820, 1),
  ('location', 'shinde', 'Shinde', 830, 1),
  ('location', 'shivaji-nagar', 'Shivaji Nagar', 840, 1),
  ('location', 'shivram-colony', 'Shivram Colony', 850, 1),
  ('location', 'someshwar', 'Someshwar', 860, 1),
  ('location', 'tagore-nagar', 'Tagore Nagar', 870, 1),
  ('location', 'takli-road', 'Takli Road', 880, 1),
  ('location', 'talwade', 'Talwade', 890, 1),
  ('location', 'tapovan-road', 'Tapovan Road', 900, 1),
  ('location', 'tidke-colony', 'Tidke Colony', 910, 1),
  ('location', 'trimbak-road', 'Trimbak Road', 920, 1),
  ('location', 'trimurti-chowk', 'Trimurti Chowk', 930, 1),
  ('location', 'untawadi', 'Untawadi', 940, 1),
  ('location', 'upnagar', 'Upnagar', 950, 1),
  ('location', 'uttara-nagar', 'Uttara Nagar', 960, 1),
  ('location', 'vani', 'Vani', 970, 1),
  ('location', 'wadala', 'Wadala', 980, 1),
  ('location', 'wavre-nagar', 'Wavre Nagar', 990, 1);
