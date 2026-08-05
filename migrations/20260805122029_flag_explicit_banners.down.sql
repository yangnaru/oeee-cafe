DROP INDEX IF EXISTS idx_banners_is_explicit;

ALTER TABLE banners DROP COLUMN flagged_by;
ALTER TABLE banners DROP COLUMN flagged_at;
ALTER TABLE banners DROP COLUMN is_explicit;
