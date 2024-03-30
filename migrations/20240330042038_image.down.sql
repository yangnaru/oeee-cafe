ALTER TABLE posts ADD COLUMN width int;
ALTER TABLE posts ADD COLUMN height int;
ALTER TABLE posts ADD COLUMN paint_duration interval;
ALTER TABLE posts ADD COLUMN stroke_count int;
ALTER TABLE posts ADD COLUMN image_filename varchar(255);
ALTER TABLE posts ADD COLUMN replay_filename varchar(255);

UPDATE posts
SET width = images.width, height = images.height, paint_duration = images.paint_duration, stroke_count = images.stroke_count, image_filename = images.image_filename, replay_filename = images.replay_filename
FROM images
WHERE images.id = posts.image_id;

ALTER TABLE posts DROP COLUMN image_id;
DROP TABLE images;

ALTER TABLE posts ALTER COLUMN width SET NOT NULL;
ALTER TABLE posts ALTER COLUMN height SET NOT NULL;
ALTER TABLE posts ALTER COLUMN paint_duration SET NOT NULL;
ALTER TABLE posts ALTER COLUMN stroke_count SET NOT NULL;
ALTER TABLE posts ALTER COLUMN image_filename SET NOT NULL;
ALTER TABLE posts ALTER COLUMN replay_filename SET NOT NULL;
