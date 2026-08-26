CREATE TABLE traces (
  trace_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  meta TEXT NOT NULL,        -- JSON
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  status TEXT,
  error TEXT,
  spans TEXT NOT NULL        -- JSON array, same Span[] shape as core/observability.ts
);

CREATE INDEX idx_traces_started_at ON traces(started_at DESC);
