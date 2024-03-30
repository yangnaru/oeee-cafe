CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES users(id),
    following_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_follows_self_follow CHECK (follower_id <> following_id),
    CONSTRAINT pk_follows PRIMARY KEY (follower_id, following_id)
);
