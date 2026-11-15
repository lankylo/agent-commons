-- Migration 0011: open wallet-based pilot enrollment (ERC-4361 Sign-In with Ethereum, EOA only).
-- Stores only public data: lower-case EVM account addresses, one-time server nonces and a
-- SHA-256 digest of each server-generated challenge message. No private keys, seed phrases,
-- signatures, GitHub identity, payment credentials or KYC data are stored.

-- One-time sign-in challenges. A challenge is consumed by one conditional UPDATE that also
-- checks address, purpose, exact message digest and expiry, so it can succeed only once.
CREATE TABLE wallet_challenges (
  nonce          TEXT PRIMARY KEY
                 CHECK (length(nonce) = 32 AND nonce NOT GLOB '*[^0-9a-f]*'),
  address        TEXT NOT NULL
                 CHECK (length(address) = 42 AND address GLOB '0x*'
                        AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  purpose        TEXT NOT NULL CHECK (purpose IN ('enroll','rotate')),
  message_digest TEXT NOT NULL
                 CHECK (length(message_digest) = 64 AND message_digest NOT GLOB '*[^0-9a-f]*'),
  issued_at      TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??*Z'),
  expires_at     TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??*Z'),
  consumed_at    TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??*Z')
) STRICT;
CREATE INDEX wallet_challenges_expires_idx ON wallet_challenges (expires_at);

CREATE TRIGGER wallet_challenges_fields_immutable
BEFORE UPDATE OF nonce, address, purpose, message_digest, issued_at, expires_at ON wallet_challenges
BEGIN SELECT RAISE(ABORT, 'wallet challenge fields are immutable'); END;
CREATE TRIGGER wallet_challenges_consumption_one_way
BEFORE UPDATE OF consumed_at ON wallet_challenges
WHEN OLD.consumed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'wallet challenge consumption is permanent'); END;

-- Each wallet account is bound to exactly one platform-assigned operator and its first agent.
-- The primary key makes concurrent first enrollments of one address resolve to one winner.
CREATE TABLE wallet_accounts (
  address      TEXT PRIMARY KEY
               CHECK (length(address) = 42 AND address GLOB '0x*'
                      AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  operator_id  TEXT NOT NULL UNIQUE,
  agent_id     TEXT NOT NULL UNIQUE,
  enrolled_at  TEXT NOT NULL CHECK (enrolled_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (agent_id, operator_id) REFERENCES agents (id, operator_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER wallet_accounts_immutable BEFORE UPDATE ON wallet_accounts
BEGIN SELECT RAISE(ABORT, 'wallet account binding is immutable'); END;
CREATE TRIGGER wallet_accounts_no_delete BEFORE DELETE ON wallet_accounts
BEGIN SELECT RAISE(ABORT, 'wallet account bindings cannot be deleted'); END;
