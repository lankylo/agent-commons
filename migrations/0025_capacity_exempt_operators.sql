-- Migration 0025: platform seeding no longer uses free-pilot places (owner decision 2026-11-22).
-- The 100 places from migration 0010 are meant for outside contributors. An operator listed in
-- pilot_capacity_exempt_operators (the platform's own seeding operator) claims no place when its
-- contributions are approved, and places it already holds stop counting toward the limit. Place
-- rows stay permanent; only what counts changes. Private/platform-only; no public path reads or
-- writes these objects. Rows are added by the owner with an explicit SQL statement.

CREATE TABLE pilot_capacity_exempt_operators (
  operator_id TEXT PRIMARY KEY REFERENCES operators(id) ON DELETE RESTRICT,
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  added_at    TEXT NOT NULL CHECK (added_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TRIGGER pilot_capacity_exempt_operators_no_update
BEFORE UPDATE ON pilot_capacity_exempt_operators
BEGIN SELECT RAISE(ABORT, 'pilot_capacity_exempt_operators rows are not edited'); END;

-- Places that count toward the limit: every place except those of an exempt operator's
-- contributions. Places with no matching contribution row still count.
CREATE VIEW pilot_capacity_counted AS
SELECT p.contribution_id
  FROM pilot_capacity_places p
 WHERE NOT EXISTS (
   SELECT 1 FROM contributions c
     JOIN pilot_capacity_exempt_operators e ON e.operator_id = c.contributor_operator_id
    WHERE c.id = p.contribution_id);

DROP TRIGGER pilot_capacity_places_limit;
CREATE TRIGGER pilot_capacity_places_limit BEFORE INSERT ON pilot_capacity_places
WHEN (SELECT count(*) FROM pilot_capacity_counted) >= 100
 AND NOT EXISTS (SELECT 1 FROM pilot_capacity_places WHERE contribution_id = NEW.contribution_id)
 AND NOT EXISTS (
   SELECT 1 FROM contributions c
     JOIN pilot_capacity_exempt_operators e ON e.operator_id = c.contributor_operator_id
    WHERE c.id = NEW.contribution_id)
BEGIN SELECT RAISE(ABORT, 'capacity_reached'); END;

DROP TRIGGER version_quality_decisions_capacity;
CREATE TRIGGER version_quality_decisions_capacity BEFORE INSERT ON version_quality_decisions
WHEN NEW.to_state = 'listed_unverified'
 AND NOT EXISTS (SELECT 1 FROM pilot_capacity_places WHERE contribution_id = NEW.contribution_id)
 AND NOT EXISTS (
   SELECT 1 FROM contributions c
     JOIN pilot_capacity_exempt_operators e ON e.operator_id = c.contributor_operator_id
    WHERE c.id = NEW.contribution_id)
 AND (SELECT count(*) FROM pilot_capacity_counted) >= 100
BEGIN SELECT RAISE(ABORT, 'capacity_reached'); END;

-- An exempt operator's approval claims no place.
DROP TRIGGER version_quality_decisions_claim_place;
CREATE TRIGGER version_quality_decisions_claim_place AFTER INSERT ON version_quality_decisions
WHEN NEW.to_state = 'listed_unverified'
 AND NOT EXISTS (
   SELECT 1 FROM contributions c
     JOIN pilot_capacity_exempt_operators e ON e.operator_id = c.contributor_operator_id
    WHERE c.id = NEW.contribution_id)
BEGIN
  INSERT OR IGNORE INTO pilot_capacity_places (contribution_id, first_version, claimed_at)
  VALUES (NEW.contribution_id, NEW.version, NEW.decided_at);
END;
