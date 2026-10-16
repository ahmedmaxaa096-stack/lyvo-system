/*
# Create scrape_results table (single-tenant, no auth)

1. New Tables
- `scrape_results`
  - `id` (uuid, primary key)
  - `url` (text, not null) — the Noon product link
  - `product_name` (text) — extracted product name
  - `image_url` (text) — extracted first image URL
  - `status` (text, default 'pending') — processing status
  - `error` (text) — error message if any
  - `created_at` (timestamptz, default now())
2. Security
- Enable RLS on `scrape_results`.
- Allow anon + authenticated CRUD because this is a single-tenant tool with no sign-in.
*/

CREATE TABLE IF NOT EXISTS scrape_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  product_name text,
  image_url text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE scrape_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_scrape_results" ON scrape_results;
CREATE POLICY "anon_select_scrape_results" ON scrape_results FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_scrape_results" ON scrape_results;
CREATE POLICY "anon_insert_scrape_results" ON scrape_results FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_scrape_results" ON scrape_results;
CREATE POLICY "anon_update_scrape_results" ON scrape_results FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_scrape_results" ON scrape_results;
CREATE POLICY "anon_delete_scrape_results" ON scrape_results FOR DELETE
  TO anon, authenticated USING (true);
