-- ===========================================================
-- 051 — Business Associate Designation master
-- ===========================================================
-- Seeds the new `business_associate_designation` vocabulary in
-- `master_lookups`. Powers the Designation dropdown on the
-- Admin → Business Associates form.
--
-- The dropdown UI (`DesignationMasterSelect`) appends its own "Others"
-- sentinel as the last option, which opens the inline add-new textbox.
-- Selecting Others + typing + clicking "Save Designation" POSTs a new
-- row into this master via the standard /admin/masters/:key/create
-- endpoint. We therefore do NOT seed a literal "Others" row — it would
-- collide with the sentinel and show up twice in the dropdown.
--
-- INSERT IGNORE keeps the migration idempotent — safe to re-run.
-- ===========================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('business_associate_designation', 'builders',                                                          'Builders',                                                          10, 1),
  ('business_associate_designation', 'architects',                                                        'Architects',                                                        20, 1),
  ('business_associate_designation', 'advocates',                                                         'Advocates',                                                         30, 1),
  ('business_associate_designation', 'chartered-accountants',                                             'Chartered Accountants',                                             40, 1),
  ('business_associate_designation', 'interior-designers',                                                'Interior Designers',                                                50, 1),
  ('business_associate_designation', 'investors',                                                         'Investors',                                                         60, 1),
  ('business_associate_designation', 'land-developers',                                                   'Land Developers',                                                   70, 1),
  ('business_associate_designation', 'end-user',                                                          'End User',                                                          80, 1),
  ('business_associate_designation', 'talathis',                                                          'Talathis',                                                          90, 1),
  ('business_associate_designation', 'tahsildars',                                                        'Tahsildars',                                                       100, 1),
  ('business_associate_designation', 'sub-registrars',                                                    'Sub-Registrars',                                                   110, 1),
  ('business_associate_designation', 'govt-valuers',                                                      'Govt. Valuers',                                                    120, 1),
  ('business_associate_designation', 'home-loan-advisors',                                                'Home Loan Advisors',                                               130, 1),
  ('business_associate_designation', 'brokers',                                                           'Brokers',                                                          140, 1),
  ('business_associate_designation', 'property-consultants',                                              'Property Consultants',                                             150, 1),
  ('business_associate_designation', 'arc-association-of-real-estate-consultants-nashik-members',        'ARC (Association of Real Estate Consultants, Nashik) Members',     160, 1),
  ('business_associate_designation', 'eaap-estate-agents-association-of-pune-members',                    'EAAP (Estate Agents Association of Pune) Members',                 170, 1),
  ('business_associate_designation', 'smart-south-metro-city-association-of-realtors-members',            'SMART (South Metro City Association of Realtors) Members',         180, 1),
  ('business_associate_designation', 'area-the-association-of-real-estate-agents-members',                'AREA (The Association of Real Estate Agents) Members',             190, 1),
  ('business_associate_designation', 'nmar-navi-mumbai-association-of-realtors-members',                  'NMAR (Navi Mumbai Association of Realtors) Members',               200, 1),
  ('business_associate_designation', 'teaa-thane-estate-agents-association-members',                      'TEAA (Thane Estate Agents Association) Members',                   210, 1),
  ('business_associate_designation', 'vra-vidarbha-realtors-association-nagpur-members',                  'VRA (Vidarbha Realtors Association, Nagpur) Members',              220, 1),
  ('business_associate_designation', 'app-association-of-property-professionals-delhi-members',           'APP (Association of Property Professionals, Delhi) Members',       230, 1),
  ('business_associate_designation', 'apra-andhra-pradesh-realtors-association-hyderabad-members',        'APRA (Andhra Pradesh Realtors Association, Hyderabad) Members',    240, 1),
  ('business_associate_designation', 'ara-ahmedabad-realtors-association-members',                        'ARA (Ahmedabad Realtors Association) Members',                     250, 1),
  ('business_associate_designation', 'abr-association-of-bhopal-realtors-members',                        'ABR (Association of Bhopal Realtors) Members',                     260, 1),
  ('business_associate_designation', 'acri-association-of-certified-realtors-of-india-delhi-members',    'ACRI (Association of Certified Realtors of India, Delhi) Members', 270, 1),
  ('business_associate_designation', 'bar-bhavnagar-association-of-realtors-members',                    'BAR (Bhavnagar Association of Realtors) Members',                  280, 1),
  ('business_associate_designation', 'brai-bangalore-realtors-association-india-members',                'BRAI (Bangalore Realtors Association India) Members',              290, 1),
  ('business_associate_designation', 'cgar-chhattisgarh-association-of-realtors-members',                'CGAR (Chhattisgarh Association of Realtors) Members',              300, 1),
  ('business_associate_designation', 'coarea-coimbatore-association-of-realtors-members',                'COAREA (Coimbatore Association of Realtors) Members',              310, 1),
  ('business_associate_designation', 'creaa-chennai-real-estate-agents-association-members',             'CREAA (Chennai Real Estate Agents Association) Members',           320, 1),
  ('business_associate_designation', 'irwa-indore-realtors-welfare-association-members',                 'IRWA (Indore Realtors Welfare Association) Members',               330, 1),
  ('business_associate_designation', 'kra-kerala-realtors-association-members',                          'KRA (Kerala Realtors Association) Members',                        340, 1),
  ('business_associate_designation', 'mra-mysore-realtors-association-members',                          'MRA (Mysore Realtors Association) Members',                        350, 1),
  ('business_associate_designation', 'ora-odisha-realtors-association-bhubaneswar-members',              'ORA (Odisha Realtors Association, Bhubaneswar) Members',           360, 1),
  ('business_associate_designation', 'reaar-real-estate-agents-association-of-rajkot-members',           'REAAR (Real Estate Agents Association of Rajkot) Members',         370, 1),
  ('business_associate_designation', 'reca-realtors-and-estate-consultants-association-kolkata-members',  'RECA (Realtors & Estate Consultants Association, Kolkata) Members', 380, 1),
  ('business_associate_designation', 'rra-rajasthan-realtors-association-jaipur-members',                'RRA (Rajasthan Realtors Association, Jaipur) Members',             390, 1),
  ('business_associate_designation', 'sra-surat-realtors-association-members',                           'SRA (Surat Realtors Association) Members',                         400, 1),
  ('business_associate_designation', 'vra-vadodara-realtors-association-members',                        'VRA (Vadodara Realtors Association) Members',                      410, 1);
