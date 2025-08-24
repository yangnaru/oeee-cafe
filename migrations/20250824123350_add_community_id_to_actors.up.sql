ALTER TABLE actors ADD COLUMN community_id UUID REFERENCES communities(id);

-- Add constraint to ensure actors can be associated with either a user OR a community, but not both
ALTER TABLE actors ADD CONSTRAINT check_actor_exclusivity 
    CHECK ((user_id IS NOT NULL AND community_id IS NULL) OR (user_id IS NULL AND community_id IS NOT NULL));