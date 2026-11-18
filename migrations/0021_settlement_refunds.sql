-- Migration 0021: settlement hold, refunds, reversals and licence withdrawal (Phase 6, no live
-- money).
--
-- 1. Settlement hold (owner decision 2026-11-18: 7 days). An earning or reward moves from
--    `pending` to `available` only 7 days after it was recorded, and, when it names a
--    contribution version, only while that version is still verified by the platform. Until then
--    it stays pending and can be reversed in full.
-- 2. Ledger adjustments. Every refund and reversal made by the operator reviewer is recorded with
--    its reason in `ledger_adjustments` (append-only), next to the ledger entry it created.
-- 3. Licence withdrawal. A refunded purchase withdraws the licence it granted:
--    `entitlement_revocations` (append-only) may name an entitlement only once its purchase has
--    been refunded in full. A withdrawn licence no longer gives access.
-- Each trigger body holds one statement.

CREATE TRIGGER ledger_entries_settlement_hold BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'settlement'
BEGIN
  SELECT RAISE(ABORT, 'settlement_hold')
  WHERE (SELECT julianday(NEW.created_at) - julianday(r.created_at) FROM ledger_entries r
         WHERE r.entry_id = NEW.related_entry_id) < 7;
END;

CREATE TRIGGER ledger_entries_settlement_verified BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'settlement'
 AND (SELECT contribution_id FROM ledger_entries WHERE entry_id = NEW.related_entry_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'settlement_unverified')
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_entries r
    JOIN version_trust t ON t.contribution_id = r.contribution_id AND t.version = r.version
    WHERE r.entry_id = NEW.related_entry_id AND t.verified = 1
  );
END;

CREATE TABLE ledger_adjustments (
  adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id INTEGER NOT NULL UNIQUE REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  kind          TEXT    NOT NULL CHECK (kind IN ('refund','reversal')),
  reason        TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  set_by        TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  created_at    TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TRIGGER ledger_adjustments_no_update BEFORE UPDATE ON ledger_adjustments
BEGIN SELECT RAISE(ABORT, 'ledger_adjustments is append-only'); END;
CREATE TRIGGER ledger_adjustments_no_delete BEFORE DELETE ON ledger_adjustments
BEGIN SELECT RAISE(ABORT, 'ledger_adjustments is append-only'); END;

CREATE TRIGGER ledger_adjustments_kind_matches BEFORE INSERT ON ledger_adjustments
BEGIN
  SELECT RAISE(ABORT, 'adjustment_mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e
                    WHERE e.entry_id = NEW.ledger_entry_id AND e.entry_type = NEW.kind);
END;

CREATE TABLE entitlement_revocations (
  purchase_entry_id INTEGER PRIMARY KEY
                    REFERENCES purchase_entitlements (purchase_entry_id) ON DELETE RESTRICT,
  reason            TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  revoked_at        TEXT    NOT NULL CHECK (revoked_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TRIGGER entitlement_revocations_no_update BEFORE UPDATE ON entitlement_revocations
BEGIN SELECT RAISE(ABORT, 'entitlement_revocations is append-only'); END;
CREATE TRIGGER entitlement_revocations_no_delete BEFORE DELETE ON entitlement_revocations
BEGIN SELECT RAISE(ABORT, 'entitlement_revocations is append-only'); END;

CREATE TRIGGER entitlement_revocations_refunded BEFORE INSERT ON entitlement_revocations
BEGIN
  SELECT RAISE(ABORT, 'revocation_not_refunded')
  WHERE (SELECT COALESCE(SUM(f.amount_minor), 0) FROM ledger_entries f
         WHERE f.related_entry_id = NEW.purchase_entry_id AND f.entry_type = 'refund')
      < (SELECT amount_minor FROM ledger_entries WHERE entry_id = NEW.purchase_entry_id);
END;
