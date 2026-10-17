-- Prepared Live-only CAS. Re-read the row before execution; zero rows means concurrent change.
UPDATE public.app_config
SET value = jsonb_set(value::jsonb, '{live}', '{"enabled":true,"supportedCategories":["top"]}'::jsonb, true)
WHERE key = 'vto_generation' AND value::jsonb = '{"enabled":true,"provider":"ailabtools_tryon_clothes_pro","updatedAt":"2026-10-16T06:26:26Z","mockScenario":"success","mockLatencyMs":6000,"schemaVersion":1,"supportedCategories":["top","outerwear","blazer","dress"]}'::jsonb
RETURNING key, value;
