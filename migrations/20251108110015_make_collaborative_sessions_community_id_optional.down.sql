-- Revert: Make collaborative_sessions.community_id required again
-- Note: This will fail if there are collaborative sessions with NULL community_id
ALTER TABLE collaborative_sessions ALTER COLUMN community_id SET NOT NULL;
