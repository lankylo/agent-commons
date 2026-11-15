-- Migration 0010: free-pilot capacity of 100 distinct approved contribution IDs (Phase 5).
-- A place is used by the FIRST approval (pending -> listed_unverified) of a contribution ID.
-- Later versions of that ID use no additional place. Rejection never uses a place and
-- withdrawal never frees one: rows here are permanent. Private/platform-only; no public path
-- reads or writes this table.
-- Enforcement is inside D1: the check and the claim run in the same statement transaction as
-- the decision insert (one D1 batch), and SQLite serializes writers, so concurrent reviewers
-- cannot approve IDs 100 and 101. At capacity the decision insert aborts with
-- 'capacity_reached', rolling back the batch: no state change and no decision-history row.

CREATE TABLE pilot_capacity_places (
  contribution_id TEXT    PRIMARY KEY CHECK (length(contribution_id) BETWEEN 1 AND 128),
  first_version   INTEGER NOT NULL CHECK (first_version >= 1),
  claimed_at      TEXT    NOT NULL CHECK (claimed_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

-- Count approvals that predate this migration: every ID with an approval decision, plus any
-- ID whose version is currently listed or withdrawn (which implies an earlier approval).
INSERT INTO pilot_capacity_places (contribution_id, first_version, claimed_at)
SELECT contribution_id, min(version), min(at) FROM (
  SELECT contribution_id, version, decided_at AS at
    FROM version_quality_decisions WHERE to_state = 'listed_unverified'
  UNION ALL
  SELECT contribution_id, version, updated_at AS at
    FROM version_quality_states WHERE state IN ('listed_unverified','withdrawn')
) GROUP BY contribution_id;

CREATE TRIGGER pilot_capacity_places_no_update BEFORE UPDATE ON pilot_capacity_places
BEGIN SELECT RAISE(ABORT, 'pilot_capacity_places is permanent'); END;
CREATE TRIGGER pilot_capacity_places_no_delete BEFORE DELETE ON pilot_capacity_places
BEGIN SELECT RAISE(ABORT, 'pilot_capacity_places is permanent'); END;
CREATE TRIGGER pilot_capacity_places_limit BEFORE INSERT ON pilot_capacity_places
WHEN (SELECT count(*) FROM pilot_capacity_places) >= 100
 AND NOT EXISTS (SELECT 1 FROM pilot_capacity_places WHERE contribution_id = NEW.contribution_id)
BEGIN SELECT RAISE(ABORT, 'capacity_reached'); END;

-- First approval of an ID at capacity is refused before anything is recorded.
CREATE TRIGGER version_quality_decisions_capacity BEFORE INSERT ON version_quality_decisions
WHEN NEW.to_state = 'listed_unverified'
 AND NOT EXISTS (SELECT 1 FROM pilot_capacity_places WHERE contribution_id = NEW.contribution_id)
 AND (SELECT count(*) FROM pilot_capacity_places) >= 100
BEGIN SELECT RAISE(ABORT, 'capacity_reached'); END;

-- A recorded approval claims the ID's place (no-op for later versions of the same ID).
CREATE TRIGGER version_quality_decisions_claim_place AFTER INSERT ON version_quality_decisions
WHEN NEW.to_state = 'listed_unverified'
BEGIN
  INSERT OR IGNORE INTO pilot_capacity_places (contribution_id, first_version, claimed_at)
  VALUES (NEW.contribution_id, NEW.version, NEW.decided_at);
END;
