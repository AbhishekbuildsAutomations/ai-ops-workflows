-- Failure ledger: one row per distinct error signature.
-- Runs automatically on the first `docker compose up` (mounted into docker-entrypoint-initdb.d).
-- On an existing volume, run it by hand:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < workflows/00-error-handling/sql/schema.sql

CREATE TABLE IF NOT EXISTS failure_ledger (
    id               bigserial   PRIMARY KEY,
    -- workflow id | failed node | error message with ids, numbers, urls, timestamps masked.
    -- Two failures with the same signature are the same bug.
    signature        text        NOT NULL UNIQUE,
    workflow_id      text,
    workflow_name    text        NOT NULL,
    failed_node      text,
    error_message    text        NOT NULL,   -- raw message of the latest occurrence
    execution_id     text,                   -- latest occurrence
    execution_url    text,                   -- latest occurrence
    first_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz NOT NULL DEFAULT now(),
    recurrence_count integer     NOT NULL DEFAULT 1,
    status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed')),
    fixed_at         timestamptz
);

-- The weekly digest filters on these.
CREATE INDEX IF NOT EXISTS failure_ledger_first_seen_idx ON failure_ledger (first_seen_at);
CREATE INDEX IF NOT EXISTS failure_ledger_last_seen_idx  ON failure_ledger (last_seen_at);
