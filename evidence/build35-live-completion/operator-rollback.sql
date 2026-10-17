-- Prior Production Live member was absent. Preserve all unrelated current fields.
UPDATE public.app_config
SET value = value::jsonb - 'live'
WHERE key = 'vto_generation' AND value::jsonb -> 'live' = '{"enabled":true,"supportedCategories":["top"]}'::jsonb
RETURNING key, value;
-- Emergency kill instead: set only {live,enabled} to false after re-reading current Live value.
