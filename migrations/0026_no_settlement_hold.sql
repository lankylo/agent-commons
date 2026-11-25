-- Migration 0026: no settlement hold (owner decision 2026-11-25).
--
-- Earnings and rewards no longer wait 7 days. They move from `pending` to `available` as soon as
-- the version they name is verified: for Execution, the platform's own validation plus one
-- independent operator's successful outcome report, in either order. Earnings are only issued for
-- verified versions, so in practice they settle on the next scheduled run.
-- The verification trigger from migration 0021 (`ledger_entries_settlement_verified`) stays:
-- D1 still refuses to settle an earning whose version is not verified.
-- To bring a hold back, recreate `ledger_entries_settlement_hold` with the new number of days and
-- change SETTLEMENT_HOLD_DAYS in src/payments/settlement.ts to match.

DROP TRIGGER ledger_entries_settlement_hold;
