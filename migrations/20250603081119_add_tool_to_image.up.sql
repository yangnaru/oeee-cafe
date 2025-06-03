-- Claude 3.5 Sonnet
-- Add tool enum('neo', 'tegaki', 'cucumber') column to images table. The initial value should be set from preexisting data. If images.replay_filename ends with '.tgkr', initial value should be 'tegaki'. If community that image's post belongs to has a foreground_color and background_color set, initial value should be 'cucumber'. Else if images.replay_filename ends with '.pch', initial value should be 'neo'. Make the query compatible with PostgreSQL.

-- Create enum type if not exists
CREATE TYPE tool AS ENUM ('neo', 'tegaki', 'cucumber');

-- Add tool column
ALTER TABLE images ADD COLUMN tool tool;

-- Update tool values based on conditions
UPDATE images i
SET tool = CASE
    WHEN i.replay_filename LIKE '%.tgkr' THEN 'tegaki'::tool
    WHEN EXISTS (
        SELECT 1
        FROM posts p
        JOIN communities c ON p.community_id = c.id
        WHERE p.image_id = i.id
        AND c.foreground_color IS NOT NULL
        AND c.background_color IS NOT NULL
    ) THEN 'cucumber'::tool
    WHEN i.replay_filename LIKE '%.pch' THEN 'neo'::tool
END;

-- Make tool column NOT NULL
ALTER TABLE images ALTER COLUMN tool SET NOT NULL;
