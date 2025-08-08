-- Add back background_color column to collaborative_sessions table

ALTER TABLE collaborative_sessions ADD COLUMN background_color BIGINT DEFAULT 4294967295;