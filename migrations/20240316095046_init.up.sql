CREATE TABLE sessions (
    id text primary key not null,
    data bytea not null,
    expiry_date timestamptz not null
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_name varchar(255) NOT NULL UNIQUE,
  display_name varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id),
  name varchar(255) NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paint_duration interval NOT NULL,
  title varchar(255) NOT NULL,
  content text NOT NULL,
  author_id uuid NOT NULL REFERENCES users (id),
  community_id uuid NOT NULL REFERENCES communities (id),
  image_sha256 bytea NOT NULL,
  animation_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
