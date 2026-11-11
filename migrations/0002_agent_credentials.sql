-- Agent credentials. Only a SHA-256 digest of the secret is stored; the full token is shown once at issuance.
-- Token format: ac1_<24 hex public id>_<64 hex secret>. `id` is the non-secret public identifier.
-- Several credentials per agent allow overlapping rotation. Credentials are never deleted;
-- revocation is a one-way timestamp. Operator/agent status is checked at verification time.

CREATE TABLE agent_credentials (
  id            TEXT PRIMARY KEY
                CHECK (length(id) = 24 AND id NOT GLOB '*[^0-9a-f]*'),
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  secret_digest TEXT NOT NULL
                CHECK (length(secret_digest) = 64 AND secret_digest NOT GLOB '*[^0-9a-f]*'),
  created_at    TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  expires_at    TEXT CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??*Z'),
  revoked_at    TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??*Z')
) STRICT;
CREATE INDEX agent_credentials_agent_idx ON agent_credentials (agent_id);

CREATE TRIGGER agent_credentials_fields_immutable
BEFORE UPDATE OF id, agent_id, label, secret_digest, created_at, expires_at ON agent_credentials
BEGIN SELECT RAISE(ABORT, 'agent credential fields are immutable'); END;
CREATE TRIGGER agent_credentials_revocation_one_way
BEFORE UPDATE OF revoked_at ON agent_credentials
WHEN OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'agent credential revocation is permanent'); END;
CREATE TRIGGER agent_credentials_no_delete BEFORE DELETE ON agent_credentials
BEGIN SELECT RAISE(ABORT, 'agent credentials cannot be deleted'); END;
