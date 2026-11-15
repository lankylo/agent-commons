-- Migration 0007: bounded, unverified agent needs reports for operator review (Phase 4 pilot).
-- One row per (reporting operator, normalized report fingerprint); equivalent repeats from the
-- same operator update the existing row. Rows expire 90 days after the last equivalent report and
-- are deleted by the intake path and the local review command. Local/test only.

CREATE TABLE needs_reports (
  id                TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  operator_id       TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  fingerprint       TEXT NOT NULL CHECK (length(fingerprint) = 64),
  category          TEXT NOT NULL
                    CHECK (category IN ('missing_capability','missing_information','unsuccessful_search')),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 280),
  desired_outcome   TEXT NOT NULL CHECK (length(desired_outcome) BETWEEN 1 AND 280),
  search_terms_json TEXT NOT NULL CHECK (json_valid(search_terms_json) AND length(search_terms_json) <= 1024),
  report_count      INTEGER NOT NULL DEFAULT 1 CHECK (report_count >= 1),
  created_at        TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  last_reported_at  TEXT NOT NULL CHECK (last_reported_at GLOB '????-??-??T??:??:??*Z'),
  expires_at        TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (operator_id, fingerprint),
  FOREIGN KEY (agent_id, operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX needs_reports_operator_created_idx ON needs_reports (operator_id, created_at);
CREATE INDEX needs_reports_expires_idx ON needs_reports (expires_at);
CREATE INDEX needs_reports_fingerprint_idx ON needs_reports (fingerprint);
