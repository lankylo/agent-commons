-- Migration 0004: shared D1-backed rate-limit counters for Phase 4 worker auth.
-- Local/test use only until a separately approved deployment task creates and applies remote DBs.

CREATE TABLE rate_limit_windows (
  scope         TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  window_start  TEXT NOT NULL CHECK (window_start GLOB '????-??-??T??:??:??*Z'),
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (scope, window_start)
) STRICT;
CREATE INDEX rate_limit_windows_scope_idx ON rate_limit_windows (scope);
