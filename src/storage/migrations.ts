/**
 * Ordered, append-only schema migrations. Never edit an applied migration; add a new one.
 * Timestamps are ISO-8601 UTC strings; JSON columns hold redacted, size-capped documents.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE workflows (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        version         INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_workflows_owner ON workflows(owner_id, created_at DESC);

      CREATE TABLE executions (
        id               TEXT PRIMARY KEY,
        workflow_id      TEXT NOT NULL REFERENCES workflows(id),
        workflow_version INTEGER NOT NULL,
        owner_id         TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
        input_json       TEXT NOT NULL,
        error_json       TEXT,
        request_id       TEXT,
        created_at       TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT,
        duration_ms      INTEGER
      );
      CREATE INDEX idx_executions_owner ON executions(owner_id, created_at DESC);
      CREATE INDEX idx_executions_workflow ON executions(workflow_id, created_at DESC);
      CREATE INDEX idx_executions_status ON executions(status);

      CREATE TABLE step_runs (
        id              TEXT PRIMARY KEY,
        execution_id    TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        step_id         TEXT NOT NULL,
        capability      TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled')),
        provider        TEXT,
        is_mock         INTEGER NOT NULL DEFAULT 0,
        attempts        INTEGER NOT NULL DEFAULT 0,
        fallback_from   TEXT,
        output_json     TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        error_json      TEXT,
        verification_id TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        duration_ms     INTEGER,
        UNIQUE (execution_id, step_id)
      );

      CREATE TABLE verifications (
        id              TEXT PRIMARY KEY,
        execution_id    TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        step_id         TEXT NOT NULL,
        owner_id        TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('passed','failed','error')),
        checks_json     TEXT NOT NULL,
        assessment_json TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_verifications_execution ON verifications(execution_id);

      CREATE TABLE audit_events (
        id            TEXT PRIMARY KEY,
        ts            TEXT NOT NULL,
        actor_id      TEXT,
        action        TEXT NOT NULL,
        resource_type TEXT,
        resource_id   TEXT,
        request_id    TEXT,
        outcome       TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
        details_json  TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_events(ts DESC);

      CREATE TABLE provider_calls (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                 TEXT NOT NULL,
        provider           TEXT NOT NULL,
        capability         TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('success','error')),
        error_code         TEXT,
        latency_ms         INTEGER NOT NULL,
        attempts           INTEGER NOT NULL,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        total_tokens       INTEGER,
        estimated_cost_usd REAL,
        is_mock            INTEGER NOT NULL DEFAULT 0,
        execution_id       TEXT,
        request_id         TEXT
      );
      CREATE INDEX idx_provider_calls_ts ON provider_calls(ts DESC);
      CREATE INDEX idx_provider_calls_provider ON provider_calls(provider, ts DESC);
    `,
  },
];
