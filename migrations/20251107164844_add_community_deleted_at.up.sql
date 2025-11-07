-- Add deleted_at column to communities table
ALTER TABLE communities ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Create index for queries filtering on deleted communities
CREATE INDEX idx_communities_deleted_at ON communities(deleted_at) WHERE deleted_at IS NOT NULL;
