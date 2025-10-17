-- Drop indexes
DROP INDEX IF EXISTS idx_post_hashtags_hashtag_id;
DROP INDEX IF EXISTS idx_post_hashtags_post_id;
DROP INDEX IF EXISTS idx_hashtags_post_count;
DROP INDEX IF EXISTS idx_hashtags_name;

-- Drop tables
DROP TABLE IF EXISTS post_hashtags;
DROP TABLE IF EXISTS hashtags;
