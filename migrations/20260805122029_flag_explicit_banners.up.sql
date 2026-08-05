-- Staff flag for banners that should not appear on the public /about page.
-- Distinct from posts.is_sensitive: that one is author-set and only blurs the
-- image, whereas this is staff-set and removes the banner from /about entirely.
ALTER TABLE banners ADD COLUMN is_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE banners ADD COLUMN flagged_at timestamptz;
ALTER TABLE banners ADD COLUMN flagged_by uuid REFERENCES users(id);

-- /about filters these out on every render, and flagged banners are rare, so a
-- partial index keeps the lookup cheap.
CREATE INDEX idx_banners_is_explicit ON banners(is_explicit) WHERE is_explicit;
