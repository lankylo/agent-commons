-- Migration 0013: platform-computed trust signals (Phase 5).
-- `source_checks` is an append-only log of deterministic Knowledge source re-checks: the platform
-- fetched the recorded source and compared its SHA-256 with the hash stored on the immutable
-- version. `version_trust` holds the latest derived summary per exact version. Both are
-- platform-only: no contributor path writes them and nothing here changes a version's listing
-- state. A version is never "verified" because its contributor said so.

CREATE TABLE source_checks (
  check_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  checked_at      TEXT    NOT NULL CHECK (checked_at GLOB '????-??-??T??:??:??*Z'),
  outcome         TEXT    NOT NULL CHECK (outcome IN ('match','mismatch','unreachable')),
  http_status     INTEGER CHECK (http_status BETWEEN 100 AND 599),
  observed_digest TEXT    CHECK (observed_digest IS NULL
                                 OR (length(observed_digest) = 64
                                     AND observed_digest NOT GLOB '*[^0-9a-f]*')),
  CHECK ((outcome = 'unreachable') = (observed_digest IS NULL)),
  FOREIGN KEY (contribution_id, version, ordinal)
    REFERENCES knowledge_sources (contribution_id, version, ordinal) ON DELETE RESTRICT
) STRICT;
CREATE INDEX source_checks_source_idx
  ON source_checks (contribution_id, version, ordinal, check_id);

CREATE TRIGGER source_checks_no_update BEFORE UPDATE ON source_checks
BEGIN SELECT RAISE(ABORT, 'source_checks is append-only'); END;
CREATE TRIGGER source_checks_no_delete BEFORE DELETE ON source_checks
BEGIN SELECT RAISE(ABORT, 'source_checks is append-only'); END;

-- source_status: none (no sources: Execution), unchecked, matched (every source matched at its
-- latest check), unconfirmed (a hash has never been reproduced), changed (a source that matched
-- before no longer does), unreachable.
CREATE TABLE version_trust (
  contribution_id      TEXT    NOT NULL,
  version              INTEGER NOT NULL,
  source_status        TEXT    NOT NULL
                       CHECK (source_status IN
                         ('none','unchecked','matched','unconfirmed','changed','unreachable')),
  source_checked_at    TEXT    CHECK (source_checked_at GLOB '????-??-??T??:??:??*Z'),
  confirming_operators INTEGER NOT NULL DEFAULT 0 CHECK (confirming_operators >= 0),
  disputing_operators  INTEGER NOT NULL DEFAULT 0 CHECK (disputing_operators >= 0),
  reporting_operators  INTEGER NOT NULL DEFAULT 0 CHECK (reporting_operators >= 0),
  stale_reports        INTEGER NOT NULL DEFAULT 0 CHECK (stale_reports >= 0),
  verified             INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  updated_at           TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER version_trust_key_immutable BEFORE UPDATE OF contribution_id, version
  ON version_trust
BEGIN SELECT RAISE(ABORT, 'version_trust key is immutable'); END;
