-- First, update any NULL values to false
UPDATE posts SET is_sensitive = false WHERE is_sensitive IS NULL;

-- Then, set NOT NULL constraint with default value
ALTER TABLE posts ALTER COLUMN is_sensitive SET DEFAULT false;
ALTER TABLE posts ALTER COLUMN is_sensitive SET NOT NULL;
