-- Add new actor_id columns
ALTER TABLE follows 
ADD COLUMN follower_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
ADD COLUMN following_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE;

-- Migrate existing data from user IDs to actor IDs
UPDATE follows 
SET follower_actor_id = (
    SELECT a.id 
    FROM actors a 
    WHERE a.user_id = follows.follower_id
),
following_actor_id = (
    SELECT a.id 
    FROM actors a 
    WHERE a.user_id = follows.following_id
);

-- Remove old constraints and add new ones
ALTER TABLE follows DROP CONSTRAINT IF EXISTS pk_follows;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_follower_id_fkey;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_following_id_fkey;

-- Make new columns NOT NULL
ALTER TABLE follows ALTER COLUMN follower_actor_id SET NOT NULL;
ALTER TABLE follows ALTER COLUMN following_actor_id SET NOT NULL;

-- Add new primary key and constraints
ALTER TABLE follows ADD CONSTRAINT pk_follows_actors PRIMARY KEY (follower_actor_id, following_actor_id);
ALTER TABLE follows ADD CONSTRAINT follows_no_self_follow CHECK (follower_actor_id != following_actor_id);

-- Create indexes
CREATE INDEX idx_follows_follower_actor_id ON follows(follower_actor_id);
CREATE INDEX idx_follows_following_actor_id ON follows(following_actor_id);

-- Remove old user ID columns from follows table
ALTER TABLE follows DROP COLUMN follower_id;
ALTER TABLE follows DROP COLUMN following_id;