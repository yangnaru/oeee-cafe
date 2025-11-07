-- Remove column
ALTER TABLE posts DROP COLUMN deletion_reason;

-- Drop enum type
DROP TYPE post_deletion_reason;
