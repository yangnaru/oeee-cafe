CREATE TABLE guestbook_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id uuid NOT NULL REFERENCES users(id),
    recipient_id uuid NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    reply TEXT DEFAULT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    replied_at timestamptz DEFAULT NULL
);
