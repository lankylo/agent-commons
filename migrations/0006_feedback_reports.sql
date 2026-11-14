-- Migration 0006: one active unverified feedback report per consumer operator,
-- exact contribution version, and family-specific dimension. Local/test only.

CREATE TABLE feedback_reports (
  consumer_operator_id TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  contribution_id       TEXT NOT NULL,
  version               INTEGER NOT NULL,
  dimension             TEXT NOT NULL
                        CHECK (dimension IN ('accuracy','usefulness','staleness','outcome','compatibility')),
  assessment_json       TEXT NOT NULL
                        CHECK (json_valid(assessment_json)),
  PRIMARY KEY (consumer_operator_id, contribution_id, version, dimension),
  FOREIGN KEY (agent_id, consumer_operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
