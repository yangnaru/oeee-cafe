-- Remove the exclusivity constraint
ALTER TABLE actors DROP CONSTRAINT check_actor_exclusivity;

ALTER TABLE actors DROP COLUMN community_id;