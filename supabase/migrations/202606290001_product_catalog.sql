-- Product catalog — staging-safe foundation for scan-identify retrieval.
-- Target: App Staging only. Do NOT run against Production until catalog rows are validated.
-- Forward-only migration. No destructive table operations.

-- Create table
CREATE TABLE IF NOT EXISTS public.product_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer text NOT NULL,
  brand text,
  product_name text NOT NULL,
  canonical_category text NOT NULL,
  raw_category text,
  description text,
  price numeric,
  currency text DEFAULT 'USD',
  product_url text,
  image_url text,
  availability text DEFAULT 'unknown',
  color_normalized text,
  material_tags text[] DEFAULT '{}',
  silhouette_tags text[] DEFAULT '{}',
  style_tags text[] DEFAULT '{}',
  pattern_tags text[] DEFAULT '{}',
  distinctive_features text[] DEFAULT '{}',
  search_text text,
  source text DEFAULT 'manual',
  external_product_id text,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Comment for clarity
COMMENT ON TABLE public.product_catalog IS 'Staging product catalog for scan-identify retrieval. Not for Production until validated.';

-- Indexes
CREATE INDEX IF NOT EXISTS product_catalog_canonical_category_idx
  ON public.product_catalog (canonical_category);

CREATE INDEX IF NOT EXISTS product_catalog_color_normalized_idx
  ON public.product_catalog (color_normalized);

CREATE INDEX IF NOT EXISTS product_catalog_availability_idx
  ON public.product_catalog (availability);

CREATE INDEX IF NOT EXISTS product_catalog_retailer_idx
  ON public.product_catalog (retailer);

CREATE INDEX IF NOT EXISTS product_catalog_brand_idx
  ON public.product_catalog (brand);

CREATE INDEX IF NOT EXISTS product_catalog_material_tags_gin
  ON public.product_catalog USING gin (material_tags);

CREATE INDEX IF NOT EXISTS product_catalog_silhouette_tags_gin
  ON public.product_catalog USING gin (silhouette_tags);

CREATE INDEX IF NOT EXISTS product_catalog_style_tags_gin
  ON public.product_catalog USING gin (style_tags);

CREATE INDEX IF NOT EXISTS product_catalog_distinctive_features_gin
  ON public.product_catalog USING gin (distinctive_features);

-- Enable RLS. No public read policies for v1.
ALTER TABLE public.product_catalog ENABLE ROW LEVEL SECURITY;

-- Updated_at trigger (simple, consistent with existing trigger patterns if any).
-- If the project already has a trigger function, we reuse it; otherwise create one.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'
  ) THEN
    CREATE FUNCTION public.set_updated_at()
    RETURNS trigger AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'product_catalog_updated_at'
  ) THEN
    CREATE TRIGGER product_catalog_updated_at
      BEFORE UPDATE ON public.product_catalog
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

-- Verify table exists
SELECT count(*) FROM public.product_catalog;
