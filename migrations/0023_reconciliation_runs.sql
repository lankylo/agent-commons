-- Migration 0023: recorded reconciliation runs (Phase 6 monitoring).
--
-- Each run of the reconciliation report (scheduled daily, or on demand by the operator reviewer)
-- is kept append-only with its alerts, so the owner can see when a problem started. Only
-- aggregate figures and alert codes are stored: no identities, addresses or keys.

CREATE TABLE reconciliation_runs (
  run_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at       TEXT    NOT NULL CHECK (ran_at GLOB '????-??-??T??:??:??*Z'),
  trigger_kind TEXT    NOT NULL CHECK (trigger_kind IN ('scheduled','reviewer')),
  ok           INTEGER NOT NULL CHECK (ok IN (0,1)),
  alerts_json  TEXT    NOT NULL CHECK (json_valid(alerts_json) AND json_type(alerts_json) = 'array'),
  report_json  TEXT    NOT NULL CHECK (json_valid(report_json) AND json_type(report_json) = 'object')
) STRICT;

CREATE TRIGGER reconciliation_runs_no_update BEFORE UPDATE ON reconciliation_runs
BEGIN SELECT RAISE(ABORT, 'reconciliation_runs is append-only'); END;
CREATE TRIGGER reconciliation_runs_no_delete BEFORE DELETE ON reconciliation_runs
BEGIN SELECT RAISE(ABORT, 'reconciliation_runs is append-only'); END;
