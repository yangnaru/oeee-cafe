-- Revert: Make posts.community_id required again
-- Note: This will fail if there are posts with NULL community_id
ALTER TABLE posts ALTER COLUMN community_id SET NOT NULL;
