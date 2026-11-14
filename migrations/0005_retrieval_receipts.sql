-- Migration 0005: minimal Phase 4 exact-version feedback eligibility receipts.
-- Local/test use only until separately approved remote migration work.

CREATE TABLE retrieval_receipts (
  agent_id        TEXT    NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  PRIMARY KEY (agent_id, contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
