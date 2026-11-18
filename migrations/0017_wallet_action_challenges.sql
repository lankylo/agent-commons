-- Migration 0017: one-time wallet challenges for operator actions (Phase 6, no live money).
-- An enrolled wallet signs a server-built ERC-4361 message to set its operator's spending policy
-- or to suspend or resume spending. Each challenge is bound to the exact request by a SHA-256
-- digest of its canonical JSON, which the signed message also names, so a signature cannot be
-- reused for a different request. Like `wallet_challenges` (migration 0011), only public data is
-- stored: no private keys or signatures. A challenge is consumed by one conditional UPDATE that
-- checks address, purpose, request digest, message digest and expiry, so it succeeds only once.

CREATE TABLE wallet_action_challenges (
  nonce          TEXT PRIMARY KEY
                 CHECK (length(nonce) = 32 AND nonce NOT GLOB '*[^0-9a-f]*'),
  address        TEXT NOT NULL
                 CHECK (length(address) = 42 AND address GLOB '0x*'
                        AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  purpose        TEXT NOT NULL CHECK (purpose IN ('spending-policy','spending-suspension')),
  request_digest TEXT NOT NULL
                 CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  message_digest TEXT NOT NULL
                 CHECK (length(message_digest) = 64 AND message_digest NOT GLOB '*[^0-9a-f]*'),
  issued_at      TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??*Z'),
  expires_at     TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??*Z'),
  consumed_at    TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??*Z')
) STRICT;
CREATE INDEX wallet_action_challenges_expires_idx ON wallet_action_challenges (expires_at);

CREATE TRIGGER wallet_action_challenges_fields_immutable
BEFORE UPDATE OF nonce, address, purpose, request_digest, message_digest, issued_at, expires_at
  ON wallet_action_challenges
BEGIN SELECT RAISE(ABORT, 'wallet action challenge fields are immutable'); END;
CREATE TRIGGER wallet_action_challenges_consumption_one_way
BEFORE UPDATE OF consumed_at ON wallet_action_challenges
WHEN OLD.consumed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet action challenge consumption is permanent'); END;
