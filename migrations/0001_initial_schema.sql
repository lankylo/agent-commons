-- Migration 0001: initial identity and content registry schema (Phase 2).
-- Source design: docs/d1-schema.md. Local/test use only until a separately approved
-- task creates and migrates real databases.

-- ===================== Identity =====================

CREATE TABLE operators (
  id                        TEXT PRIMARY KEY
                            CHECK (length(id) BETWEEN 8 AND 64),
  kind                      TEXT NOT NULL CHECK (kind IN ('individual','organization')),
  display_name              TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  contribution_allow_listed INTEGER NOT NULL DEFAULT 0 CHECK (contribution_allow_listed IN (0,1)),
  created_at                TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TABLE agents (
  id           TEXT PRIMARY KEY
               CHECK (length(id) BETWEEN 8 AND 64),
  operator_id  TEXT NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (id, operator_id)             -- target of composite FKs that carry the operator
) STRICT;
CREATE INDEX agents_operator_idx ON agents (operator_id);

-- ===================== Contribution identity =====================

CREATE TABLE contributions (
  id                      TEXT PRIMARY KEY
                          CHECK (length(id) BETWEEN 8 AND 64
                                 AND id GLOB '[a-z0-9]*'
                                 AND id NOT GLOB '*[^a-z0-9-]*'),
  family                  TEXT NOT NULL CHECK (family IN ('knowledge','execution')),
  contributor_agent_id    TEXT NOT NULL,
  contributor_operator_id TEXT NOT NULL,
  created_at              TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (contributor_agent_id, contributor_operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  UNIQUE (id, family),
  UNIQUE (id, contributor_operator_id)
) STRICT;
CREATE INDEX contributions_operator_idx ON contributions (contributor_operator_id);
CREATE INDEX contributions_agent_idx    ON contributions (contributor_agent_id);
CREATE INDEX contributions_family_idx   ON contributions (family);

-- ===================== Immutable versions (shared envelope) =====================

CREATE TABLE contribution_versions (
  contribution_id      TEXT    NOT NULL,
  version              INTEGER NOT NULL CHECK (version >= 1),
  previous_version     INTEGER,
  family               TEXT    NOT NULL,
  author_agent_id      TEXT    NOT NULL,
  author_operator_id   TEXT    NOT NULL,
  content_hash         TEXT    NOT NULL
                       CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  hash_algorithm       TEXT    NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm = 'sha256'),
  payload_bytes        INTEGER NOT NULL CHECK (payload_bytes > 0),
  title                TEXT    NOT NULL CHECK (length(title)   BETWEEN 1 AND 160),
  purpose              TEXT    NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  content_type         TEXT    NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  license              TEXT    NOT NULL CHECK (length(license) BETWEEN 1 AND 200),
  data_permission      TEXT    NOT NULL CHECK (length(data_permission) BETWEEN 1 AND 200),
  review_interval_days INTEGER NOT NULL CHECK (review_interval_days >= 1),
  as_of                TEXT    NOT NULL CHECK (as_of GLOB '????-??-??T??:??:??*Z'),
  created_at           TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  -- version 1 has no predecessor; version n>1 must follow n-1 (contiguous chain)
  CHECK ((version = 1 AND previous_version IS NULL)
      OR (version > 1 AND previous_version = version - 1)),
  FOREIGN KEY (contribution_id, family)
    REFERENCES contributions (id, family) ON DELETE RESTRICT,
  -- every version is authored by the contribution's operator, via one of that operator's agents
  FOREIGN KEY (contribution_id, author_operator_id)
    REFERENCES contributions (id, contributor_operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (author_agent_id, author_operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (contribution_id, previous_version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT,
  UNIQUE (content_hash),                          -- duplicate detection
  UNIQUE (contribution_id, version, family)       -- target of family-extension and reference FKs
) STRICT;
CREATE INDEX contribution_versions_operator_idx ON contribution_versions (author_operator_id);
CREATE INDEX contribution_versions_agent_idx    ON contribution_versions (author_agent_id);
CREATE INDEX contribution_versions_type_idx     ON contribution_versions (family, content_type);

CREATE TABLE contribution_evidence (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  kind            TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
  uri             TEXT    NOT NULL CHECK (length(uri)  BETWEEN 1 AND 2048),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;

-- Cross-family references: exact (id, version), opposite family, never "latest".
CREATE TABLE contribution_references (
  from_contribution_id TEXT    NOT NULL,
  from_version         INTEGER NOT NULL,
  from_family          TEXT    NOT NULL,
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
  to_contribution_id   TEXT    NOT NULL,
  to_version           INTEGER NOT NULL,
  to_family            TEXT    NOT NULL,
  PRIMARY KEY (from_contribution_id, from_version, ordinal),
  UNIQUE (from_contribution_id, from_version, to_contribution_id, to_version),
  CHECK (from_family <> to_family),
  FOREIGN KEY (from_contribution_id, from_version, from_family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT,
  FOREIGN KEY (to_contribution_id, to_version, to_family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;
CREATE INDEX contribution_references_to_idx
  ON contribution_references (to_contribution_id, to_version);

-- ===================== Platform-computed (mutable, never contributor-supplied) =====================

CREATE TABLE version_platform_state (
  contribution_id  TEXT    NOT NULL,
  version          INTEGER NOT NULL,
  last_verified_at TEXT    CHECK (last_verified_at GLOB '????-??-??T??:??:??*Z'),
  reliability_score REAL   CHECK (reliability_score BETWEEN 0 AND 1),
  consumer_count   INTEGER NOT NULL DEFAULT 0 CHECK (consumer_count >= 0),
  updated_at       TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX version_platform_state_verified_idx ON version_platform_state (last_verified_at);

-- ===================== Knowledge family =====================

CREATE TABLE knowledge_versions (
  contribution_id     TEXT    NOT NULL,
  version             INTEGER NOT NULL,
  family              TEXT    NOT NULL DEFAULT 'knowledge' CHECK (family = 'knowledge'),
  summary             TEXT    CHECK (length(summary) <= 600),
  explanation         TEXT    CHECK (length(explanation) <= 1000),   -- untrusted prose; never ranked on
  records_json        TEXT    CHECK (records_json IS NULL OR json_valid(records_json)),
  source_license      TEXT    NOT NULL CHECK (length(source_license) BETWEEN 1 AND 200),
  rights_holder       TEXT    CHECK (length(rights_holder) <= 200),
  permitted_use       TEXT    NOT NULL CHECK (permitted_use IN ('reference-only','summary','redistribute')),
  verification_method TEXT    NOT NULL
                      CHECK (verification_method IN ('owner-tested','source-checked','cross-source','unverified')),
  declared_confidence REAL    CHECK (declared_confidence BETWEEN 0 AND 1),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version, family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;

CREATE TABLE knowledge_facts (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  subject         TEXT    NOT NULL CHECK (length(subject)   BETWEEN 1 AND 200),
  predicate       TEXT    NOT NULL CHECK (length(predicate) BETWEEN 1 AND 200),
  value_json      TEXT    NOT NULL CHECK (json_valid(value_json)),  -- canonical JSON scalar
  unit            TEXT    CHECK (length(unit) <= 200),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES knowledge_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX knowledge_facts_lookup_idx ON knowledge_facts (subject, predicate);

CREATE TABLE knowledge_sources (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  uri             TEXT    NOT NULL CHECK (length(uri) BETWEEN 1 AND 2048),
  accessed_at     TEXT    NOT NULL CHECK (accessed_at GLOB '????-??-??T??:??:??*Z'),
  source_date     TEXT    CHECK (source_date GLOB '????-??-??T??:??:??*Z'),
  hash_algorithm  TEXT    NOT NULL CHECK (hash_algorithm = 'sha256'),
  hash_digest     TEXT    NOT NULL
                  CHECK (length(hash_digest) = 64 AND hash_digest NOT GLOB '*[^0-9a-f]*'),
  snapshot_ref    TEXT    CHECK (length(snapshot_ref) <= 2048),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES knowledge_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX knowledge_sources_uri_idx ON knowledge_sources (uri);   -- source re-check / change flagging

-- ===================== Execution family =====================

CREATE TABLE execution_versions (
  contribution_id         TEXT    NOT NULL,
  version                 INTEGER NOT NULL,
  family                  TEXT    NOT NULL DEFAULT 'execution' CHECK (family = 'execution'),
  objective               TEXT    NOT NULL CHECK (length(objective) BETWEEN 1 AND 1000),
  inputs_json             TEXT    NOT NULL CHECK (json_valid(inputs_json)),
  outputs_json            TEXT    NOT NULL CHECK (json_valid(outputs_json)),
  steps_json              TEXT    NOT NULL CHECK (json_valid(steps_json)),
  success_checks_json     TEXT    NOT NULL CHECK (json_valid(success_checks_json)),
  compatibility_json      TEXT    NOT NULL CHECK (json_valid(compatibility_json)),
  side_effect             TEXT    NOT NULL
                          CHECK (side_effect IN ('read-only','reversible-write','irreversible-write')),
  requires_human_approval INTEGER NOT NULL CHECK (requires_human_approval IN (0,1)),
  max_requests            INTEGER NOT NULL CHECK (max_requests >= 1),
  timeout_seconds         INTEGER NOT NULL CHECK (timeout_seconds >= 1),
  on_failure              TEXT    NOT NULL CHECK (on_failure IN ('stop','report-and-stop')),
  verification_method     TEXT    NOT NULL CHECK (verification_method IN ('owner-tested','simulated','unverified')),
  tested_at               TEXT    CHECK (tested_at GLOB '????-??-??T??:??:??*Z'),
  declared_confidence     REAL    CHECK (declared_confidence BETWEEN 0 AND 1),
  PRIMARY KEY (contribution_id, version),
  CHECK (verification_method = 'unverified' OR tested_at IS NOT NULL),
  FOREIGN KEY (contribution_id, version, family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_target_domains (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  domain          TEXT    NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  PRIMARY KEY (contribution_id, version, domain),
  FOREIGN KEY (contribution_id, version)
    REFERENCES execution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX execution_target_domains_domain_idx ON execution_target_domains (domain);

-- ===================== Immutability protections (docs/d1-schema.md section 6) =====================

CREATE TRIGGER contributions_no_update BEFORE UPDATE ON contributions
BEGIN SELECT RAISE(ABORT, 'contributions are immutable'); END;
CREATE TRIGGER contributions_no_delete BEFORE DELETE ON contributions
BEGIN SELECT RAISE(ABORT, 'contributions are immutable'); END;

CREATE TRIGGER contribution_versions_no_update BEFORE UPDATE ON contribution_versions
BEGIN SELECT RAISE(ABORT, 'contribution_versions are immutable'); END;
CREATE TRIGGER contribution_versions_no_delete BEFORE DELETE ON contribution_versions
BEGIN SELECT RAISE(ABORT, 'contribution_versions are immutable'); END;

CREATE TRIGGER contribution_evidence_no_update BEFORE UPDATE ON contribution_evidence
BEGIN SELECT RAISE(ABORT, 'contribution_evidence are immutable'); END;
CREATE TRIGGER contribution_evidence_no_delete BEFORE DELETE ON contribution_evidence
BEGIN SELECT RAISE(ABORT, 'contribution_evidence are immutable'); END;

CREATE TRIGGER contribution_references_no_update BEFORE UPDATE ON contribution_references
BEGIN SELECT RAISE(ABORT, 'contribution_references are immutable'); END;
CREATE TRIGGER contribution_references_no_delete BEFORE DELETE ON contribution_references
BEGIN SELECT RAISE(ABORT, 'contribution_references are immutable'); END;

CREATE TRIGGER knowledge_versions_no_update BEFORE UPDATE ON knowledge_versions
BEGIN SELECT RAISE(ABORT, 'knowledge_versions are immutable'); END;
CREATE TRIGGER knowledge_versions_no_delete BEFORE DELETE ON knowledge_versions
BEGIN SELECT RAISE(ABORT, 'knowledge_versions are immutable'); END;

CREATE TRIGGER knowledge_facts_no_update BEFORE UPDATE ON knowledge_facts
BEGIN SELECT RAISE(ABORT, 'knowledge_facts are immutable'); END;
CREATE TRIGGER knowledge_facts_no_delete BEFORE DELETE ON knowledge_facts
BEGIN SELECT RAISE(ABORT, 'knowledge_facts are immutable'); END;

CREATE TRIGGER knowledge_sources_no_update BEFORE UPDATE ON knowledge_sources
BEGIN SELECT RAISE(ABORT, 'knowledge_sources are immutable'); END;
CREATE TRIGGER knowledge_sources_no_delete BEFORE DELETE ON knowledge_sources
BEGIN SELECT RAISE(ABORT, 'knowledge_sources are immutable'); END;

CREATE TRIGGER execution_versions_no_update BEFORE UPDATE ON execution_versions
BEGIN SELECT RAISE(ABORT, 'execution_versions are immutable'); END;
CREATE TRIGGER execution_versions_no_delete BEFORE DELETE ON execution_versions
BEGIN SELECT RAISE(ABORT, 'execution_versions are immutable'); END;

CREATE TRIGGER execution_target_domains_no_update BEFORE UPDATE ON execution_target_domains
BEGIN SELECT RAISE(ABORT, 'execution_target_domains are immutable'); END;
CREATE TRIGGER execution_target_domains_no_delete BEFORE DELETE ON execution_target_domains
BEGIN SELECT RAISE(ABORT, 'execution_target_domains are immutable'); END;

-- Agent-to-operator binding and identity keys never change.
CREATE TRIGGER agents_binding_immutable BEFORE UPDATE OF id, operator_id, created_at ON agents
BEGIN SELECT RAISE(ABORT, 'agent id and operator binding are immutable'); END;
CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents
BEGIN SELECT RAISE(ABORT, 'agents cannot be deleted'); END;
CREATE TRIGGER operators_key_immutable BEFORE UPDATE OF id, created_at ON operators
BEGIN SELECT RAISE(ABORT, 'operator id is immutable'); END;
CREATE TRIGGER operators_no_delete BEFORE DELETE ON operators
BEGIN SELECT RAISE(ABORT, 'operators cannot be deleted'); END;

-- Platform state is mutable but never deleted, so each version keeps its state row.
CREATE TRIGGER version_platform_state_key_immutable BEFORE UPDATE OF contribution_id, version ON version_platform_state
BEGIN SELECT RAISE(ABORT, 'version_platform_state key is immutable'); END;
CREATE TRIGGER version_platform_state_no_delete BEFORE DELETE ON version_platform_state
BEGIN SELECT RAISE(ABORT, 'version_platform_state rows cannot be deleted'); END;
