-- Migration 28: structured, immutable Store service terms.
--
-- Apply before deploying the matching application code. Existing listings
-- remain valid fixed-price offers with empty structured detail. Every NEW
-- Store task receives an atomic JSON snapshot through the trigger below, so
-- later listing edits cannot change the terms the buyer hired.

ALTER TABLE agent_listings
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS included_items JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS required_inputs JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS output_formats TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_pricing_mode_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_pricing_mode_check
      CHECK (pricing_mode = 'fixed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_revision_count_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_revision_count_check
      CHECK (revision_count BETWEEN 0 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_included_items_array_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_included_items_array_check
      CHECK (jsonb_typeof(included_items) = 'array' AND jsonb_array_length(included_items) <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_required_inputs_array_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_required_inputs_array_check
      CHECK (jsonb_typeof(required_inputs) = 'array' AND jsonb_array_length(required_inputs) <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_listings_output_formats_check') THEN
    ALTER TABLE agent_listings ADD CONSTRAINT agent_listings_output_formats_check
      CHECK (
        cardinality(output_formats) <= 10
        AND output_formats <@ ARRAY[
          'csv', 'xlsx', 'json', 'pdf', 'docx', 'markdown',
          'plain_text', 'html', 'source_code', 'other'
        ]::TEXT[]
      );
  END IF;
END $$;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS store_listing_terms JSONB;

CREATE OR REPLACE FUNCTION snapshot_store_listing_terms()
RETURNS TRIGGER AS $$
DECLARE
  v_listing agent_listings%ROWTYPE;
BEGIN
  IF NEW.source = 'store' THEN
    IF NEW.store_listing_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Store task requires a listing';
    END IF;

    SELECT l.* INTO v_listing
      FROM agent_listings l
     WHERE l.id = NEW.store_listing_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Store listing not found';
    END IF;

    NEW.store_listing_terms := jsonb_build_object(
      'listing_id', v_listing.id,
      'pricing_mode', v_listing.pricing_mode,
      'price_eur', v_listing.price_eur,
      'delivery_hours', v_listing.delivery_hours,
      'included_items', v_listing.included_items,
      'required_inputs', v_listing.required_inputs,
      'output_formats', to_jsonb(v_listing.output_formats),
      'revision_count', v_listing.revision_count,
      'snapshotted_at', CLOCK_TIMESTAMP()
    );
  ELSIF NEW.store_listing_terms IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only Store tasks may contain Store listing terms';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;

DROP TRIGGER IF EXISTS trg_snapshot_store_listing_terms ON tasks;
CREATE TRIGGER trg_snapshot_store_listing_terms
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION snapshot_store_listing_terms();

REVOKE ALL ON FUNCTION snapshot_store_listing_terms() FROM PUBLIC, anon, authenticated;
