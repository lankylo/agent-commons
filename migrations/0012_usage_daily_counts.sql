-- Migration 0012: aggregate daily usage counters for the operator-only pilot usage snapshot.
-- Counts only: no agent, operator, query text or contribution identifiers are stored.

CREATE TABLE usage_daily_counts (
  day       TEXT    NOT NULL CHECK (day GLOB '????-??-??'),
  operation TEXT    NOT NULL CHECK (operation IN ('search', 'retrieval')),
  count     INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, operation)
) STRICT;
