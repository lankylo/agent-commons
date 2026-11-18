-- Migration 0020: USDC deposits verified on Base (Phase 6; Base Sepolia test USDC first).
--
-- An operator sends USDC from its enrolled wallet to the platform's deposit address, then its
-- agent claims the transfer by transaction hash. The Worker reads the receipt from the chain, and
-- each matching USDC Transfer log is credited once, as `operator_funding` to the claiming agent.
-- `chain_deposits` is append-only and keyed by chain, transaction and log index, so a transfer can
-- never be credited twice, and every row names the ledger entry it created. Only public chain data
-- is stored.

CREATE TABLE chain_deposits (
  chain_id        INTEGER NOT NULL CHECK (chain_id > 0),
  tx_hash         TEXT    NOT NULL
                  CHECK (length(tx_hash) = 66 AND tx_hash GLOB '0x*'
                         AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*'),
  log_index       INTEGER NOT NULL CHECK (log_index >= 0),
  token_address   TEXT    NOT NULL
                  CHECK (length(token_address) = 42 AND token_address GLOB '0x*'
                         AND substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'),
  from_address    TEXT    NOT NULL
                  CHECK (length(from_address) = 42 AND from_address GLOB '0x*'
                         AND substr(from_address, 3) NOT GLOB '*[^0-9a-f]*'),
  to_address      TEXT    NOT NULL
                  CHECK (length(to_address) = 42 AND to_address GLOB '0x*'
                         AND substr(to_address, 3) NOT GLOB '*[^0-9a-f]*'),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  block_number    INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash      TEXT    NOT NULL CHECK (length(block_hash) = 66 AND block_hash GLOB '0x*'),
  ledger_entry_id INTEGER NOT NULL UNIQUE REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  credited_at     TEXT    NOT NULL CHECK (credited_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (chain_id, tx_hash, log_index)
) STRICT;
CREATE INDEX chain_deposits_from_idx ON chain_deposits (from_address, chain_id);

CREATE TRIGGER chain_deposits_no_update BEFORE UPDATE ON chain_deposits
BEGIN SELECT RAISE(ABORT, 'chain_deposits is append-only'); END;
CREATE TRIGGER chain_deposits_no_delete BEFORE DELETE ON chain_deposits
BEGIN SELECT RAISE(ABORT, 'chain_deposits is append-only'); END;

-- A deposit row must name an operator_funding entry of exactly its amount, in USDC.
CREATE TRIGGER chain_deposits_matches_ledger BEFORE INSERT ON chain_deposits
BEGIN
  SELECT RAISE(ABORT, 'deposit_ledger_mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e
                    WHERE e.entry_id = NEW.ledger_entry_id
                      AND e.entry_type = 'operator_funding'
                      AND e.amount_minor = NEW.amount_minor
                      AND e.currency = 'USDC');
END;
