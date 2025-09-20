-- Rollback comments table migration

-- Drop index
DROP INDEX IF EXISTS idx_comments_actor_id;

-- Add user_id column back
ALTER TABLE comments ADD COLUMN user_id uuid;

-- Populate user_id from actor_id
UPDATE comments
SET user_id = (
    SELECT a.user_id
    FROM actors a
    WHERE a.id = comments.actor_id
);

-- Make user_id NOT NULL
ALTER TABLE comments ALTER COLUMN user_id SET NOT NULL;

-- Add foreign key constraint for user_id
ALTER TABLE comments ADD CONSTRAINT comments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Drop actor_id foreign key constraint
ALTER TABLE comments DROP CONSTRAINT fk_comments_actor_id;

-- Drop actor_id and iri columns
ALTER TABLE comments DROP COLUMN actor_id;
ALTER TABLE comments DROP COLUMN iri;