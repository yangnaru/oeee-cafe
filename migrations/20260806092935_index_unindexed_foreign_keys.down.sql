DROP INDEX IF EXISTS idx_posts_author_published;
DROP INDEX IF EXISTS idx_posts_community_published;
DROP INDEX IF EXISTS idx_posts_author_id;
DROP INDEX IF EXISTS idx_posts_parent_post_id;
DROP INDEX IF EXISTS idx_posts_explicit_flagged_by;

DROP INDEX IF EXISTS idx_comments_post_created;

DROP INDEX IF EXISTS idx_notifications_actor_id;
DROP INDEX IF EXISTS idx_notifications_comment_id;
DROP INDEX IF EXISTS idx_notifications_guestbook_entry_id;
DROP INDEX IF EXISTS idx_notifications_reaction_iri;

DROP INDEX IF EXISTS idx_guestbook_entries_recipient_id;
DROP INDEX IF EXISTS idx_guestbook_entries_author_id;

DROP INDEX IF EXISTS idx_links_user_id;

DROP INDEX IF EXISTS idx_users_banner_id;

DROP INDEX IF EXISTS idx_communities_owner_id;

DROP INDEX IF EXISTS idx_banners_author_id;
DROP INDEX IF EXISTS idx_banners_flagged_by;

DROP INDEX IF EXISTS idx_email_verification_challenges_user_id;

DROP INDEX IF EXISTS idx_actors_community_id;
DROP INDEX IF EXISTS idx_actors_instance_host;

DROP INDEX IF EXISTS idx_collab_sessions_community_id;
DROP INDEX IF EXISTS idx_collab_sessions_saved_post_id;

DROP INDEX IF EXISTS idx_community_members_invited_by;
DROP INDEX IF EXISTS idx_community_invitations_inviter_id;
