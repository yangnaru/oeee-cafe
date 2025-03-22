ALTER TABLE communities
DROP CONSTRAINT check_foreground_background_colors;

ALTER TABLE communities
DROP COLUMN foreground_color,
DROP COLUMN background_color;