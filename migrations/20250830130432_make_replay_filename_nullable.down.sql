-- Revert making images.replay_filename nullable
-- Note: This will fail if there are null values in replay_filename

-- First, update any null values to a placeholder
UPDATE images SET replay_filename = 'placeholder.pch' WHERE replay_filename IS NULL;

-- Then make the column NOT NULL again
ALTER TABLE images ALTER COLUMN replay_filename SET NOT NULL;