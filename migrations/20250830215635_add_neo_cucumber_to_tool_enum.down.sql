-- Remove 'neo-cucumber' value from the tool enum
-- Note: This is a destructive operation and will fail if there are existing records with 'neo-cucumber'
-- In production, you may need to update existing records first

-- First, update any existing records to use 'cucumber' instead of 'neo-cucumber'
UPDATE images SET tool = 'cucumber'::tool WHERE tool = 'neo-cucumber'::tool;

-- Then remove the enum value (this requires recreating the enum in PostgreSQL < 14)
-- For PostgreSQL 14+, this would be: ALTER TYPE tool DROP VALUE 'neo-cucumber';
-- For older versions, we need to recreate the enum:

ALTER TABLE images ALTER COLUMN tool TYPE text;
DROP TYPE tool;
CREATE TYPE tool AS ENUM ('neo', 'tegaki', 'cucumber');
ALTER TABLE images ALTER COLUMN tool TYPE tool USING tool::tool;