-- Remove unique constraint from slug column
ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_slug_key;
