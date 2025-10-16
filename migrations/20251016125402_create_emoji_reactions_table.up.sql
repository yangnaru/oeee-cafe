CREATE TABLE reactions (
    iri TEXT PRIMARY KEY NOT NULL,
    post_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT reactions_post_id_fk
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,

    CONSTRAINT reactions_actor_id_fk
        FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE CASCADE,

    CONSTRAINT reactions_emoji_check
        CHECK (emoji IS NOT NULL AND length(emoji) > 0),

    CONSTRAINT reactions_unique_reaction
        UNIQUE (post_id, actor_id, emoji)
);

CREATE INDEX idx_reactions_post_id ON reactions(post_id);
CREATE INDEX idx_reactions_actor_id ON reactions(actor_id);
