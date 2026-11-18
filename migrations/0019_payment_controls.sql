-- Migration 0019: platform-wide payment controls (Phase 6, no live money).
--
-- 1. Emergency stop. `platform_payment_controls` is append-only; the latest row applies and no
--    row means payments run. While stopped, D1 refuses every entry that adds money or exposure:
--    funding, reservations (so purchases), withdrawals, earnings, rewards and settlements.
--    Unwinding stays possible: releases, refunds and reversals are still accepted.
-- 2. Reward cap. Verification rewards are paid by the platform before it has revenue, so their
--    total (rewards issued minus rewards reversed) is capped. `platform_reward_caps` is
--    append-only; the latest row applies, and with no row the cap is 100 USDC (100,000,000 base
--    units).
-- Each trigger body holds one statement.

CREATE TABLE platform_payment_controls (
  control_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT    NOT NULL CHECK (action IN ('stop','start')),
  reason     TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  set_by     TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  created_at TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TRIGGER platform_payment_controls_no_update BEFORE UPDATE ON platform_payment_controls
BEGIN SELECT RAISE(ABORT, 'platform_payment_controls is append-only'); END;
CREATE TRIGGER platform_payment_controls_no_delete BEFORE DELETE ON platform_payment_controls
BEGIN SELECT RAISE(ABORT, 'platform_payment_controls is append-only'); END;

CREATE TABLE platform_reward_caps (
  cap_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  cap_minor  INTEGER NOT NULL CHECK (cap_minor >= 0 AND cap_minor <= 1000000000000),
  reason     TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  set_by     TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  created_at TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TRIGGER platform_reward_caps_no_update BEFORE UPDATE ON platform_reward_caps
BEGIN SELECT RAISE(ABORT, 'platform_reward_caps is append-only'); END;
CREATE TRIGGER platform_reward_caps_no_delete BEFORE DELETE ON platform_reward_caps
BEGIN SELECT RAISE(ABORT, 'platform_reward_caps is append-only'); END;

CREATE TRIGGER ledger_entries_payments_stopped BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type IN ('operator_funding','reservation','withdrawal','task_earning','tip',
                        'contribution_revenue_share','settlement')
BEGIN
  SELECT RAISE(ABORT, 'payments_stopped')
  WHERE (SELECT action FROM platform_payment_controls ORDER BY control_id DESC LIMIT 1) = 'stop';
END;

CREATE TRIGGER ledger_entries_reward_cap BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'task_earning' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward_cap_reached')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE entry_type = 'task_earning' AND contribution_id IS NOT NULL)
      - (SELECT COALESCE(SUM(x.amount_minor), 0) FROM ledger_entries x
         JOIN ledger_entries r ON r.entry_id = x.related_entry_id
         WHERE x.entry_type = 'reversal' AND r.entry_type = 'task_earning'
           AND r.contribution_id IS NOT NULL)
      + NEW.amount_minor
      > COALESCE((SELECT cap_minor FROM platform_reward_caps ORDER BY cap_id DESC LIMIT 1),
                 100000000);
END;
