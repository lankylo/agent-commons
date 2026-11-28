-- Migration 0027: x402 payments (owner decision 2026-11-28; design in docs/x402.md).
--
-- An agent can pay for one exact priced version per request with x402: it signs a USDC
-- transferWithAuthorization (EIP-3009) and the Coinbase CDP facilitator settles it on Base, so
-- the Worker never signs a transaction. The paying wallet becomes an operator (`wallet_accounts`,
-- migration 0011) and the purchase is recorded through the existing provider path: funding,
-- reservation, purchase, licence and the contributor's share in one D1 batch.
--
-- 1. `x402_payments`: one row per verified payment authorization, keyed by its EIP-3009 nonce, so
--    an authorization can never be used twice. Written before settlement.
-- 2. `x402_payment_events`: what happened next, each at most once per payment: settled (with the
--    transaction hash), settle_failed, settle_unknown (the facilitator did not answer), recorded
--    (the ledger batch succeeded) or record_failed. A payment settled or unknown but never
--    recorded is raised by reconciliation for the owner.
-- Both tables are append-only and hold only public chain data.
-- Each trigger body holds one statement.

CREATE TABLE x402_payments (
  nonce           TEXT    PRIMARY KEY
                  CHECK (length(nonce) = 66 AND nonce GLOB '0x*'
                         AND substr(nonce, 3) NOT GLOB '*[^0-9a-f]*'),
  network         TEXT    NOT NULL CHECK (network IN ('eip155:8453', 'eip155:84532')),
  payer           TEXT    NOT NULL
                  CHECK (length(payer) = 42 AND payer GLOB '0x*'
                         AND substr(payer, 3) NOT GLOB '*[^0-9a-f]*'),
  operator_id     TEXT    NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at      TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX x402_payments_operator_idx ON x402_payments (operator_id, created_at);

CREATE TRIGGER x402_payments_no_update BEFORE UPDATE ON x402_payments
BEGIN SELECT RAISE(ABORT, 'x402_payments is append-only'); END;
CREATE TRIGGER x402_payments_no_delete BEFORE DELETE ON x402_payments
BEGIN SELECT RAISE(ABORT, 'x402_payments is append-only'); END;

CREATE TABLE x402_payment_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  nonce        TEXT    NOT NULL REFERENCES x402_payments (nonce) ON DELETE RESTRICT,
  event        TEXT    NOT NULL
               CHECK (event IN ('settled', 'settle_failed', 'settle_unknown', 'recorded',
                                'record_failed')),
  tx_hash      TEXT    CHECK (tx_hash IS NULL
                              OR (length(tx_hash) = 66 AND tx_hash GLOB '0x*'
                                  AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*')),
  purchase_ref TEXT    CHECK (purchase_ref IS NULL OR length(purchase_ref) BETWEEN 1 AND 128),
  detail       TEXT    CHECK (detail IS NULL OR length(detail) <= 200),
  created_at   TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (nonce, event),
  CHECK (event <> 'settled' OR tx_hash IS NOT NULL)
) STRICT;

CREATE TRIGGER x402_payment_events_no_update BEFORE UPDATE ON x402_payment_events
BEGIN SELECT RAISE(ABORT, 'x402_payment_events is append-only'); END;
CREATE TRIGGER x402_payment_events_no_delete BEFORE DELETE ON x402_payment_events
BEGIN SELECT RAISE(ABORT, 'x402_payment_events is append-only'); END;
