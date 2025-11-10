-- Reverse the NOT NULL constraint
ALTER TABLE posts ALTER COLUMN is_sensitive DROP NOT NULL;
ALTER TABLE posts ALTER COLUMN is_sensitive DROP DEFAULT;
