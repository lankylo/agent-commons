-- Migration 0008: platform-owned quality state per exact contribution version (Phase 5 storage
-- foundation only). States: pending, listed_unverified, rejected, withdrawn. This migration adds
-- storage; nothing reads it yet, so it does not gate search, retrieval or publication.
-- Contributors cannot supply it. No reviewer decisions exist yet, so no row can leave 'pending'
-- through application code. Existing versions have never been reviewed and are backfilled as
-- 'pending' (never listed_unverified or any approved/verified state). Local/test only.

CREATE TABLE version_quality_states (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  state           TEXT    NOT NULL
                  CHECK (state IN ('pending','listed_unverified','rejected','withdrawn')),
  updated_at      TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX version_quality_states_state_idx ON version_quality_states (state);

-- Every newly inserted version starts pending, whatever path inserts it.
CREATE TRIGGER contribution_versions_initial_quality_state AFTER INSERT ON contribution_versions
BEGIN
  INSERT INTO version_quality_states (contribution_id, version, state, updated_at)
  VALUES (NEW.contribution_id, NEW.version, 'pending', NEW.created_at);
END;

-- Existing, unreviewed versions.
INSERT INTO version_quality_states (contribution_id, version, state, updated_at)
SELECT contribution_id, version, 'pending', created_at FROM contribution_versions;

CREATE TRIGGER version_quality_states_key_immutable BEFORE UPDATE OF contribution_id, version
  ON version_quality_states
BEGIN SELECT RAISE(ABORT, 'version_quality_states key is immutable'); END;
CREATE TRIGGER version_quality_states_no_delete BEFORE DELETE ON version_quality_states
BEGIN SELECT RAISE(ABORT, 'version_quality_states cannot be deleted'); END;
