CREATE TABLE images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  width int NOT NULL,
  height int NOT NULL,
  paint_duration interval NOT NULL,
  stroke_count int NOT NULL,
  image_filename varchar(255) NOT NULL,
  replay_filename varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE posts ADD COLUMN image_id uuid REFERENCES images(id);

INSERT INTO images (width, height, paint_duration, stroke_count, image_filename, replay_filename, created_at)
SELECT width, height, paint_duration, stroke_count, image_filename, replay_filename, created_at
FROM posts;

UPDATE posts SET image_id = images.id FROM images WHERE images.image_filename = posts.image_filename;

ALTER TABLE posts DROP COLUMN width;
ALTER TABLE posts DROP COLUMN height;
ALTER TABLE posts DROP COLUMN paint_duration;
ALTER TABLE posts DROP COLUMN stroke_count;
ALTER TABLE posts DROP COLUMN image_filename;
ALTER TABLE posts DROP COLUMN replay_filename;
ALTER TABLE posts ALTER COLUMN image_id SET NOT NULL;
