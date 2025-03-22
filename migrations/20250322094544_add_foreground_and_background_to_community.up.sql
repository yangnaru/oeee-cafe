ALTER TABLE communities
ADD COLUMN foreground_color VARCHAR(7),
ADD COLUMN background_color VARCHAR(7);

ALTER TABLE communities
ADD CONSTRAINT check_foreground_background_colors
CHECK (
    (foreground_color IS NOT NULL AND background_color IS NOT NULL) OR
    (foreground_color IS NULL AND background_color IS NULL)
);