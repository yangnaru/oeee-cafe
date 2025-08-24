CREATE TABLE instances (
    host TEXT PRIMARY KEY,
    software TEXT,
    software_version TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT instance_host_check CHECK (host NOT LIKE '%@%')
);

-- Create index for lookups
CREATE INDEX idx_instances_software ON instances(software);
