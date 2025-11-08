-- Make collaborative_sessions.community_id nullable to support personal collaborative sessions
ALTER TABLE collaborative_sessions ALTER COLUMN community_id DROP NOT NULL;
