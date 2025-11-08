-- Create post_report_reason enum
CREATE TYPE post_report_reason AS ENUM (
    'spam',
    'harassment',
    'inappropriate_content',
    'copyright_violation',
    'other'
);

-- Create post_report_status enum
CREATE TYPE post_report_status AS ENUM (
    'pending',
    'reviewed',
    'actioned',
    'dismissed'
);

-- Create post_reports table
CREATE TABLE post_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason post_report_reason NOT NULL,
    details TEXT,
    status post_report_status NOT NULL DEFAULT 'pending',
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Prevent duplicate reports from the same user for the same post
    UNIQUE(post_id, reporter_id)
);

-- Indexes for efficient queries
CREATE INDEX idx_post_reports_post_id ON post_reports(post_id);
CREATE INDEX idx_post_reports_reporter_id ON post_reports(reporter_id);
CREATE INDEX idx_post_reports_status ON post_reports(status);
CREATE INDEX idx_post_reports_created_at ON post_reports(created_at DESC);

-- Composite index for admin queries (pending reports)
CREATE INDEX idx_post_reports_status_created ON post_reports(status, created_at DESC);
