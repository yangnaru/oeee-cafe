-- First, handle any duplicate slugs by appending the community ID to make them unique
-- This ensures the migration can succeed even if there are existing duplicates
WITH duplicates AS (
  SELECT slug, array_agg(id ORDER BY created_at) as ids
  FROM communities
  GROUP BY slug
  HAVING COUNT(*) > 1
)
UPDATE communities c
SET slug = c.slug || '-' || c.id
FROM duplicates d
WHERE c.slug = d.slug
  AND c.id = ANY(d.ids[2:]);  -- Update all but the first occurrence

-- Add unique constraint to the slug column
ALTER TABLE communities ADD CONSTRAINT communities_slug_key UNIQUE (slug);
