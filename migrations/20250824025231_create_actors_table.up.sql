CREATE TYPE actor_type AS ENUM ('Person', 'Service', 'Group', 'Application', 'Organization');

CREATE TABLE actors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    iri TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    type actor_type NOT NULL,
    username TEXT NOT NULL,
    instance_host TEXT NOT NULL,
    handle_host TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bio_html TEXT NOT NULL DEFAULT '',
    automatically_approves_followers BOOLEAN NOT NULL DEFAULT true,
    inbox_url TEXT NOT NULL,
    shared_inbox_url TEXT NOT NULL DEFAULT '',
    followers_url TEXT NOT NULL,
    sensitive BOOLEAN NOT NULL DEFAULT false,
    public_key_pem TEXT NOT NULL,
    private_key_pem TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_actors_user_id ON actors(user_id);
CREATE INDEX idx_actors_username ON actors(username);
CREATE INDEX idx_actors_handle ON actors(handle);
