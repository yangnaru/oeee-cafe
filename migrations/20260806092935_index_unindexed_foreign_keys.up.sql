-- Index the foreign keys that had no index behind them.
--
-- Two things were paying for this: reads (a profile page or comment thread had
-- to sequential-scan the whole table to find its rows) and writes (every
-- cascading delete on the referenced table scans the referencing one).
--
-- Where the query shape is known the index is composite and matches the sort,
-- so it can satisfy the filter and the ORDER BY together; the rest are plain
-- single-column FK indexes.
--
-- Plain CREATE INDEX, not CONCURRENTLY: sqlx runs migrations inside a
-- transaction, and at current table sizes the lock is momentary.

-- Profile feeds: WHERE author_id = $1 AND published_at IS NOT NULL
--                AND deleted_at IS NULL ORDER BY published_at DESC
CREATE INDEX IF NOT EXISTS idx_posts_author_published
    ON posts (author_id, published_at DESC)
    WHERE deleted_at IS NULL;

-- Community feeds, same shape keyed on the community.
CREATE INDEX IF NOT EXISTS idx_posts_community_published
    ON posts (community_id, published_at DESC)
    WHERE deleted_at IS NULL;

-- Plain author lookup for drafts and admin views, which do not filter on
-- published_at and so cannot use the partial index above.
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts (author_id);

CREATE INDEX IF NOT EXISTS idx_posts_parent_post_id
    ON posts (parent_post_id)
    WHERE parent_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_explicit_flagged_by
    ON posts (explicit_flagged_by)
    WHERE explicit_flagged_by IS NOT NULL;

-- Comment threads: WHERE post_id = $1 ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_comments_post_created
    ON comments (post_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_actor_id ON notifications (actor_id);
CREATE INDEX IF NOT EXISTS idx_notifications_comment_id
    ON notifications (comment_id)
    WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_guestbook_entry_id
    ON notifications (guestbook_entry_id)
    WHERE guestbook_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_reaction_iri
    ON notifications (reaction_iri)
    WHERE reaction_iri IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guestbook_entries_recipient_id
    ON guestbook_entries (recipient_id);
CREATE INDEX IF NOT EXISTS idx_guestbook_entries_author_id
    ON guestbook_entries (author_id);

CREATE INDEX IF NOT EXISTS idx_links_user_id ON links (user_id);

CREATE INDEX IF NOT EXISTS idx_users_banner_id
    ON users (banner_id)
    WHERE banner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_communities_owner_id ON communities (owner_id);

CREATE INDEX IF NOT EXISTS idx_banners_author_id ON banners (author_id);
CREATE INDEX IF NOT EXISTS idx_banners_flagged_by
    ON banners (flagged_by)
    WHERE flagged_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_verification_challenges_user_id
    ON email_verification_challenges (user_id);

CREATE INDEX IF NOT EXISTS idx_actors_community_id
    ON actors (community_id)
    WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_actors_instance_host ON actors (instance_host);

CREATE INDEX IF NOT EXISTS idx_collab_sessions_community_id
    ON collaborative_sessions (community_id)
    WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_sessions_saved_post_id
    ON collaborative_sessions (saved_post_id)
    WHERE saved_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_members_invited_by
    ON community_members (invited_by)
    WHERE invited_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_invitations_inviter_id
    ON community_invitations (inviter_id);
