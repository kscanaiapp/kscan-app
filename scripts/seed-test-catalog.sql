-- TEST DATA ONLY — APP STAGING OR LOCAL ONLY — NEVER PRODUCTION
-- Delete this file before any Production deployment.
-- These rows are generic placeholders for testing catalog retrieval.

INSERT INTO public.product_catalog (
  retailer, brand, product_name, canonical_category, description,
  price, currency, product_url, image_url, availability,
  color_normalized, material_tags, silhouette_tags, style_tags,
  distinctive_features, search_text, source, external_product_id, last_seen_at
) VALUES
  ('TEST_RETAILER_A', 'Test Brand A', 'Black Tailored Blazer', 'blazer', 'Test black blazer for staging', 299, 'USD', 'https://test.example.com/p/1', 'https://test.example.com/img/1.jpg', 'in_stock', 'black', '{"wool blend"}', '{"tailored/structured"}', '{"minimalist","workwear"}', '{"gold buttons"}', 'black tailored blazer', 'TEST', 'test-blazer-1', now()),
  ('TEST_RETAILER_B', 'Test Brand B', 'Navy Structured Blazer', 'blazer', 'Test navy blazer for staging', 350, 'USD', 'https://test.example.com/p/2', 'https://test.example.com/img/2.jpg', 'in_stock', 'navy', '{"wool blend","silk"}', '{"tailored/structured"}', '{"workwear","evening"}', '{"peak lapel","double-breasted"}', 'navy structured blazer', 'TEST', 'test-blazer-2', now()),
  ('TEST_RETAILER_A', 'Test Brand C', 'Red Floral Midi Dress', 'dress', 'Test floral midi dress for staging', 180, 'USD', 'https://test.example.com/p/3', 'https://test.example.com/img/3.jpg', 'available', 'multicolor', '{"cotton","viscose"}', '{"a-line"}', '{"feminine","summer"}', '{"puff sleeves","fitted waist"}', 'floral midi dress puff sleeves', 'TEST', 'test-dress-1', now()),
  ('TEST_RETAILER_B', 'Test Brand D', 'White Low-Top Sneakers', 'footwear', 'Test white leather sneakers for staging', 120, 'USD', 'https://test.example.com/p/4', 'https://test.example.com/img/4.jpg', 'in_stock', 'white', '{"leather","rubber"}', '{"low-top"}', '{"minimalist","casual"}', '{"minimal branding"}', 'white leather sneakers', 'TEST', 'test-sneakers-1', now()),
  ('TEST_RETAILER_A', 'Test Brand E', 'Gray Wool Coat', 'outerwear', 'Test gray wool coat for staging', 450, 'USD', 'https://test.example.com/p/5', 'https://test.example.com/img/5.jpg', 'out_of_stock', 'gray', '{"wool"}', '{"oversized/relaxed"}', '{"casual","winter"}', '{"oversized collar"}', 'gray wool coat', 'TEST', 'test-coat-1', now())
ON CONFLICT (external_product_id) DO NOTHING;
