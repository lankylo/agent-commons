-- Migration 0009: append-only reviewer decision history for version quality states (Phase 5,
-- reviewer decisions only). Platform-only: no public REST/MCP path writes these tables.
-- Allowed transitions: pending -> listed_unverified | rejected; listed_unverified -> withdrawn.
-- 'listed_unverified' means "allowed to list as unverified"; it never sets platform verification
-- or reliability fields. Nothing reads these states for search/retrieval visibility yet.
-- A state change is only possible together with a matching, valid history row; both are written
-- in one D1 batch (one transaction), so a rejected or racing decision records nothing.

CREATE TABLE version_quality_decisions (
  decision_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  from_state      TEXT    NOT NULL CHECK (from_state IN ('pending','listed_unverified')),
  to_state        TEXT    NOT NULL CHECK (to_state IN ('listed_unverified','rejected','withdrawn')),
  reviewer_id     TEXT    NOT NULL CHECK (length(reviewer_id) BETWEEN 1 AND 64),
  reason          TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  decided_at      TEXT    NOT NULL CHECK (decided_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((from_state = 'pending' AND to_state IN ('listed_unverified','rejected'))
      OR (from_state = 'listed_unverified' AND to_state = 'withdrawn')),
  FOREIGN KEY (contribution_id, version)
    REFERENCES version_quality_states (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX version_quality_decisions_version_idx
  ON version_quality_decisions (contribution_id, version, decision_id);

-- A decision is valid only against the version's current state.
CREATE TRIGGER version_quality_decisions_current_state BEFORE INSERT ON version_quality_decisions
WHEN (SELECT state FROM version_quality_states
       WHERE contribution_id = NEW.contribution_id AND version = NEW.version)
     IS NOT NEW.from_state
BEGIN SELECT RAISE(ABORT, 'quality decision does not match current state'); END;

CREATE TRIGGER version_quality_decisions_no_update BEFORE UPDATE ON version_quality_decisions
BEGIN SELECT RAISE(ABORT, 'version_quality_decisions is append-only'); END;
CREATE TRIGGER version_quality_decisions_no_delete BEFORE DELETE ON version_quality_decisions
BEGIN SELECT RAISE(ABORT, 'version_quality_decisions is append-only'); END;

-- A state may only change to match the latest decision recorded for that version.
CREATE TRIGGER version_quality_states_requires_decision BEFORE UPDATE OF state
  ON version_quality_states
WHEN NEW.state IS NOT OLD.state
 AND NOT EXISTS (
   SELECT 1 FROM version_quality_decisions d
    WHERE d.decision_id = (SELECT max(decision_id) FROM version_quality_decisions
                            WHERE contribution_id = OLD.contribution_id AND version = OLD.version)
      AND d.contribution_id = OLD.contribution_id AND d.version = OLD.version
      AND d.from_state = OLD.state AND d.to_state = NEW.state AND d.decided_at = NEW.updated_at)
BEGIN SELECT RAISE(ABORT, 'quality state change requires a matching decision'); END;
