-- Correct the CMS sidebar "Post Property, It's FREE" CTA.
-- Keep the scope limited to the sidebar-ad data; property-card links are
-- intentionally unaffected.

UPDATE cms_sidebar_ads
SET cta_url = '/seller/register'
WHERE cta_text = 'Post Property, It''s FREE'
  AND cta_url = '/properties/35';
