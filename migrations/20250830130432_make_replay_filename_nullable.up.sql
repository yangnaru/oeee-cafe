-- Make images.replay_filename column nullable for collaborative drawings
-- Collaborative drawings (neo-cucumber tool) don't have replay files

ALTER TABLE images ALTER COLUMN replay_filename DROP NOT NULL;