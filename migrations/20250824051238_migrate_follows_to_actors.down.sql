-- Re-add old user ID columns to follows table
ALTER TABLE follows 
ADD COLUMN follower_id UUID NOT NULL,
ADD COLUMN following_id UUID NOT NULL;

-- Populate old columns from actor relationships
UPDATE follows 
SET follower_id = (
    SELECT a.user_id 
    FROM actors a 
    WHERE a.id = follows.follower_actor_id
),
following_id = (
    SELECT a.user_id 
    FROM actors a 
    WHERE a.id = follows.following_actor_id
);

-- Re-add foreign key constraints
ALTER TABLE follows ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE follows ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE;

-- Drop new constraints and indexes
DROP INDEX IF EXISTS idx_follows_follower_actor_id;
DROP INDEX IF EXISTS idx_follows_following_actor_id;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS pk_follows_actors;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_no_self_follow;

-- Re-add old primary key
ALTER TABLE follows ADD CONSTRAINT pk_follows PRIMARY KEY (follower_id, following_id);

-- Drop actor columns
ALTER TABLE follows DROP COLUMN follower_actor_id;
ALTER TABLE follows DROP COLUMN following_actor_id;