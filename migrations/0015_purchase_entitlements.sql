-- Migration 0015: purchase entitlements (Phase 6, sandbox payments only).
-- One row per operator and exact contribution version it has bought. It is the licence
-- `operator-version-perpetual`: every agent of that operator may retrieve that version. Each row
-- names the ledger `purchase` entry that paid for it, of the same operator and version, so an
-- entitlement cannot exist without a recorded purchase. Rows are never changed or deleted here;
-- refund handling is a later step.

CREATE TABLE purchase_entitlements (
  operator_id       TEXT    NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  contribution_id   TEXT    NOT NULL,
  version           INTEGER NOT NULL,
  purchase_entry_id INTEGER NOT NULL UNIQUE REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  licence           TEXT    NOT NULL CHECK (licence = 'operator-version-perpetual'),
  granted_at        TEXT    NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (operator_id, contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER purchase_entitlements_no_update BEFORE UPDATE ON purchase_entitlements
BEGIN SELECT RAISE(ABORT, 'purchase_entitlements is append-only'); END;
CREATE TRIGGER purchase_entitlements_no_delete BEFORE DELETE ON purchase_entitlements
BEGIN SELECT RAISE(ABORT, 'purchase_entitlements is append-only'); END;

CREATE TRIGGER purchase_entitlements_paid BEFORE INSERT ON purchase_entitlements
BEGIN
  SELECT RAISE(ABORT, 'entitlement_unpaid')
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_entries p
    WHERE p.entry_id = NEW.purchase_entry_id
      AND p.entry_type = 'purchase'
      AND p.operator_id = NEW.operator_id
      AND p.contribution_id = NEW.contribution_id
      AND p.version = NEW.version
  );
END;
