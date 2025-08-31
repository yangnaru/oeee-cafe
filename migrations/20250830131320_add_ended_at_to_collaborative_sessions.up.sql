-- Add ended_at column to collaborative_sessions table
-- This tracks when a session was ended by the owner saving the image

ALTER TABLE collaborative_sessions ADD COLUMN ended_at TIMESTAMPTZ;