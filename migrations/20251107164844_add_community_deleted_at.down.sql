-- Drop index
DROP INDEX idx_communities_deleted_at;

-- Remove column
ALTER TABLE communities DROP COLUMN deleted_at;
