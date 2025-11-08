-- Make posts.community_id nullable to support personal posts without a community
ALTER TABLE posts ALTER COLUMN community_id DROP NOT NULL;
