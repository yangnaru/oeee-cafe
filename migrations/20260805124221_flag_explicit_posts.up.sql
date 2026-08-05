-- Staff flag for posts the author did not mark sensitive but should have.
--
-- Separate column from posts.is_sensitive on purpose: is_sensitive is written
-- by the author on every edit, so a staff decision stored there would be
-- cleared the next time they saved the post. Nothing in the author-facing
-- write path touches is_explicit.
--
-- Display treatment is identical to is_sensitive — listings and templates read
-- (is_sensitive OR is_explicit) — so a flagged post behaves exactly as if the
-- author had ticked the box.
ALTER TABLE posts ADD COLUMN is_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN explicit_flagged_at timestamptz;
ALTER TABLE posts ADD COLUMN explicit_flagged_by uuid REFERENCES users(id);

-- Flagged posts are rare and every public listing filters on this, so a partial
-- index keeps it cheap.
CREATE INDEX idx_posts_is_explicit ON posts(is_explicit) WHERE is_explicit;
