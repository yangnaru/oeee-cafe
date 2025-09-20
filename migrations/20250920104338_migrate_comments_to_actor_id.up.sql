-- Migrate comments table to reference actor_id instead of user_id
-- Add iri column for ActivityPub comments

-- Add actor_id column (temporarily nullable)
ALTER TABLE comments ADD COLUMN actor_id uuid;

-- Add iri column for ActivityPub comments
ALTER TABLE comments ADD COLUMN iri text;

-- Populate actor_id from user_id by finding the corresponding actor
UPDATE comments
SET actor_id = (
    SELECT a.id
    FROM actors a
    WHERE a.user_id = comments.user_id
);

-- Make actor_id NOT NULL (all comments should now have an actor_id)
ALTER TABLE comments ALTER COLUMN actor_id SET NOT NULL;

-- Add foreign key constraint for actor_id
ALTER TABLE comments ADD CONSTRAINT fk_comments_actor_id
    FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE CASCADE;

-- Drop the old user_id foreign key constraint
ALTER TABLE comments DROP CONSTRAINT comments_user_id_fkey;

-- Drop user_id column
ALTER TABLE comments DROP COLUMN user_id;

-- Add index on actor_id for performance
CREATE INDEX idx_comments_actor_id ON comments(actor_id);