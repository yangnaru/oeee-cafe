-- Create hashtags table
CREATE TABLE hashtags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(255) NOT NULL UNIQUE, -- lowercase normalized version for lookups
    display_name varchar(255) NOT NULL, -- original case-preserved version for display
    post_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create post_hashtags junction table
CREATE TABLE post_hashtags (
    post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, hashtag_id)
);

-- Create indexes for performance
CREATE INDEX idx_hashtags_name ON hashtags(name);
CREATE INDEX idx_hashtags_post_count ON hashtags(post_count DESC);
CREATE INDEX idx_post_hashtags_post_id ON post_hashtags(post_id);
CREATE INDEX idx_post_hashtags_hashtag_id ON post_hashtags(hashtag_id);
