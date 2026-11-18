-- Migration 0022: platform validation of Execution, one external reward, and payouts (Phase 6,
-- no live money).
--
-- 1. Platform validation (owner decision 2026-11-18). Agent Commons validates an Execution
--    version itself; it is verified once that validation and one successful outcome report from
--    an independent operator both exist, in either order. `platform_validations` is append-only;
--    the latest row for a version applies ('validate' or 'withdraw').
-- 2. One verification reward per Execution version, 0.025 USDC, to the external validator only.
--    The reward-limit trigger from migration 0018 is replaced (at most one per version).
-- 3. Payouts. An agent requests a payout of available USDC to its operator's enrolled wallet; the
--    amount is reserved. The operator approves by wallet signature (or its policy approves
--    automatically), the platform sends the USDC from its own wallet, and the Worker verifies that
--    transfer on-chain before recording the withdrawal. `payout_requests` and `payout_events` are
--    append-only; a request ends once, as sent, rejected or cancelled.
-- 4. `wallet_action_challenges` gains the 'payout-approval' purpose. SQLite cannot change a CHECK
--    in place, and challenges live five minutes, so the table is recreated empty.
-- Each trigger body holds one statement.

CREATE TABLE platform_validations (
  validation_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  action          TEXT    NOT NULL CHECK (action IN ('validate','withdraw')),
  note            TEXT    NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  set_by          TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  created_at      TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX platform_validations_version_idx
  ON platform_validations (contribution_id, version, validation_id);

CREATE TRIGGER platform_validations_no_update BEFORE UPDATE ON platform_validations
BEGIN SELECT RAISE(ABORT, 'platform_validations is append-only'); END;
CREATE TRIGGER platform_validations_no_delete BEFORE DELETE ON platform_validations
BEGIN SELECT RAISE(ABORT, 'platform_validations is append-only'); END;

CREATE TRIGGER platform_validations_execution_only BEFORE INSERT ON platform_validations
BEGIN
  SELECT RAISE(ABORT, 'validation_execution_only')
  WHERE NOT EXISTS (SELECT 1 FROM contribution_versions v
                    WHERE v.contribution_id = NEW.contribution_id AND v.version = NEW.version
                      AND v.family = 'execution');
END;

DROP TRIGGER ledger_entries_verification_reward_limit;

CREATE TRIGGER ledger_entries_verification_reward_limit BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'task_earning' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward_limit')
  WHERE (SELECT COUNT(*) FROM ledger_entries
         WHERE entry_type = 'task_earning' AND contribution_id = NEW.contribution_id
           AND version = NEW.version) >= 1
     OR (SELECT COUNT(*) FROM ledger_entries
         WHERE entry_type = 'task_earning' AND contribution_id IS NOT NULL
           AND operator_id = NEW.operator_id
           AND substr(created_at, 1, 10) = substr(NEW.created_at, 1, 10)) >= 20;
END;

CREATE TABLE payout_requests (
  request_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id          TEXT    NOT NULL,
  agent_id             TEXT    NOT NULL,
  destination          TEXT    NOT NULL
                       CHECK (length(destination) = 42 AND destination GLOB '0x*'
                              AND substr(destination, 3) NOT GLOB '*[^0-9a-f]*'),
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency             TEXT    NOT NULL CHECK (currency = 'USDC'),
  reservation_entry_id INTEGER NOT NULL UNIQUE REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  requested_at         TEXT    NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (agent_id, operator_id) REFERENCES agents (id, operator_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX payout_requests_operator_idx ON payout_requests (operator_id, request_id);

CREATE TRIGGER payout_requests_no_update BEFORE UPDATE ON payout_requests
BEGIN SELECT RAISE(ABORT, 'payout_requests is append-only'); END;
CREATE TRIGGER payout_requests_no_delete BEFORE DELETE ON payout_requests
BEGIN SELECT RAISE(ABORT, 'payout_requests is append-only'); END;

-- The request names a reservation of the same agent, amount and currency, for no contribution,
-- and pays out only to the wallet enrolled for its operator.
CREATE TRIGGER payout_requests_valid BEFORE INSERT ON payout_requests
BEGIN
  SELECT RAISE(ABORT, 'payout_request_invalid')
  WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e
                    WHERE e.entry_id = NEW.reservation_entry_id AND e.entry_type = 'reservation'
                      AND e.agent_id = NEW.agent_id AND e.amount_minor = NEW.amount_minor
                      AND e.currency = NEW.currency AND e.contribution_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM wallet_accounts w
                    WHERE w.operator_id = NEW.operator_id AND w.address = NEW.destination);
END;

CREATE TABLE payout_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES payout_requests (request_id) ON DELETE RESTRICT,
  event      TEXT    NOT NULL CHECK (event IN ('approved','rejected','cancelled','sent')),
  tx_hash    TEXT    CHECK (tx_hash IS NULL OR (length(tx_hash) = 66 AND tx_hash GLOB '0x*'
                            AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*')),
  ledger_entry_id INTEGER UNIQUE REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  reason     TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  set_by     TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  created_at TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((event = 'sent') = (tx_hash IS NOT NULL)),
  CHECK (event = 'approved' OR ledger_entry_id IS NOT NULL)
) STRICT;
CREATE INDEX payout_events_request_idx ON payout_events (request_id, event_id);
-- One on-chain transfer pays at most one payout.
CREATE UNIQUE INDEX payout_events_tx_uq ON payout_events (tx_hash) WHERE tx_hash IS NOT NULL;

CREATE TRIGGER payout_events_no_update BEFORE UPDATE ON payout_events
BEGIN SELECT RAISE(ABORT, 'payout_events is append-only'); END;
CREATE TRIGGER payout_events_no_delete BEFORE DELETE ON payout_events
BEGIN SELECT RAISE(ABORT, 'payout_events is append-only'); END;

-- Nothing happens to a request after it is sent, rejected or cancelled.
CREATE TRIGGER payout_events_closed BEFORE INSERT ON payout_events
BEGIN
  SELECT RAISE(ABORT, 'payout_closed')
  WHERE EXISTS (SELECT 1 FROM payout_events
                WHERE request_id = NEW.request_id
                  AND event IN ('rejected','cancelled','sent'));
END;

-- Approved at most once; sent only after approval.
CREATE TRIGGER payout_events_order BEFORE INSERT ON payout_events
WHEN NEW.event IN ('approved','sent')
BEGIN
  SELECT RAISE(ABORT, 'payout_out_of_order')
  WHERE (NEW.event = 'approved'
         AND EXISTS (SELECT 1 FROM payout_events
                     WHERE request_id = NEW.request_id AND event = 'approved'))
     OR (NEW.event = 'sent'
         AND NOT EXISTS (SELECT 1 FROM payout_events
                         WHERE request_id = NEW.request_id AND event = 'approved'));
END;

-- A closing event names the ledger entry that settles the reservation: a withdrawal for 'sent',
-- a reservation release for 'rejected' or 'cancelled', of the request's reservation.
CREATE TRIGGER payout_events_ledger BEFORE INSERT ON payout_events
WHEN NEW.event IN ('rejected','cancelled','sent')
BEGIN
  SELECT RAISE(ABORT, 'payout_ledger_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_entries e JOIN payout_requests p ON p.request_id = NEW.request_id
    WHERE e.entry_id = NEW.ledger_entry_id
      AND e.related_entry_id = p.reservation_entry_id
      AND e.amount_minor = p.amount_minor
      AND ((NEW.event = 'sent' AND e.entry_type = 'withdrawal')
           OR (NEW.event <> 'sent' AND e.entry_type = 'reservation_release'))
  );
END;

DROP TABLE wallet_action_challenges;

CREATE TABLE wallet_action_challenges (
  nonce          TEXT PRIMARY KEY
                 CHECK (length(nonce) = 32 AND nonce NOT GLOB '*[^0-9a-f]*'),
  address        TEXT NOT NULL
                 CHECK (length(address) = 42 AND address GLOB '0x*'
                        AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  purpose        TEXT NOT NULL
                 CHECK (purpose IN ('spending-policy','spending-suspension','payout-approval')),
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
