-- CFO Command Centre PostgreSQL DDL (Supabase / Neon Compatible)

-- 1. Employees Table
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    department VARCHAR(100) DEFAULT 'Finance',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tasks Table (Mirrors Sheet rows + status tracking)
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    tab_name VARCHAR(100) NOT NULL,
    row_index INT NOT NULL,
    id_num VARCHAR(50),
    task_description TEXT NOT NULL,
    assigned_to VARCHAR(255),
    email_id VARCHAR(255) NOT NULL,
    task_type VARCHAR(100),
    date_assigned VARCHAR(100),
    due_date VARCHAR(100),
    status VARCHAR(50) DEFAULT 'Pending',
    remarks TEXT,
    thread_id VARCHAR(255),
    days_or_overdue_days VARCHAR(50),
    is_valid BOOLEAN DEFAULT TRUE,
    validation_issue TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tab_name, row_index)
);

-- 3. Submissions Table
CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    task_id INT REFERENCES tasks(id) ON DELETE CASCADE,
    -- Stable "<tab>|<rowIndex>" Sheet-row identity; see the note on reminder_logs.
    task_key VARCHAR(120),
    sender_email VARCHAR(255) NOT NULL,
    message_id VARCHAR(255) NOT NULL,
    thread_id VARCHAR(255),
    date_received TIMESTAMP WITH TIME ZONE NOT NULL,
    classification VARCHAR(50) NOT NULL,
    remarks TEXT,
    raw_snippet TEXT,
    subject TEXT,
    -- [{filename, mimeType, sizeBytes, attachmentId, messageId}]
    attachments_json JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS task_key VARCHAR(120);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS attachments_json JSONB DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS submissions_task_key_idx ON submissions (task_key, date_received DESC);

-- 4. Reminder Logs Table
CREATE TABLE IF NOT EXISTS reminder_logs (
    id SERIAL PRIMARY KEY,
    task_id INT REFERENCES tasks(id) ON DELETE CASCADE,
    -- Stable "<tab>|<rowIndex>" identity for a Sheet row. task_id cannot serve
    -- this purpose: it is an FK into `tasks`, which the pipeline never populates,
    -- so writing the Sheet's own row number there raises a foreign-key violation.
    task_key VARCHAR(120),
    recipient_email VARCHAR(255) NOT NULL,
    reminder_type VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'DRAFTED', 'SENT', 'FAILED', 'SKIPPED'
    draft_id VARCHAR(255),
    -- Gmail message id returned by the send call. Present ONLY for a real,
    -- confirmed dispatch — this is what distinguishes "sent" from "drafted".
    message_id VARCHAR(255),
    error_text TEXT,
    sent_at TIMESTAMP WITH TIME ZONE,
    approval_id INT
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE reminder_logs ADD COLUMN IF NOT EXISTS task_key VARCHAR(120);
ALTER TABLE reminder_logs ADD COLUMN IF NOT EXISTS message_id VARCHAR(255);
ALTER TABLE reminder_logs ADD COLUMN IF NOT EXISTS error_text TEXT;
-- Which pipeline run produced this log line. Without it, abandoning a superseded
-- run leaves its throttle entries behind with no way to identify them.
ALTER TABLE reminder_logs ADD COLUMN IF NOT EXISTS run_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS reminder_logs_task_key_sent_at_idx ON reminder_logs (task_key, sent_at DESC);

-- 5. Approval Requests Table
CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    run_id VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'EXPIRED', 'RESENT'
    summary_text TEXT NOT NULL,
    reminders_json JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    resent_at TIMESTAMP WITH TIME ZONE
);
