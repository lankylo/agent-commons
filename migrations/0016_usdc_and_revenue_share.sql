-- Migration 0016: USDC amounts and the 50/50 contribution revenue share (Phase 6, no live money).
--
-- 1. Currency codes may now be 3 to 8 capital letters, so the ledger and spending policies can hold
--    USDC (amounts in USDC base units: 1 USDC = 1,000,000). SQLite cannot change a CHECK in place,
--    so `ledger_entries` and `operator_spending_policies` are rebuilt from migration 0014 with only
--    that change. Payments have been off since 0014, so both tables are empty; the guard below stops
--    this migration, before anything is dropped, if either holds a row. `purchase_entitlements` and
--    `spending_suspensions` are kept: they refer to the rebuilt tables by name.
-- 2. Two new triggers make a contribution revenue share exactly half of its purchase (rounded down)
--    and require the family success test: a Knowledge version must be verified by the platform, and
--    an Execution earning needs a successful outcome report from the purchasing operator.
-- Each trigger body holds one statement.

CREATE TABLE migration_0016_guard (rows_found INTEGER NOT NULL CHECK (rows_found = 0)) STRICT;
INSERT INTO migration_0016_guard (rows_found)
  SELECT (SELECT COUNT(*) FROM ledger_entries) + (SELECT COUNT(*) FROM operator_spending_policies)
       + (SELECT COUNT(*) FROM purchase_entitlements);
DROP TABLE migration_0016_guard;

DROP TABLE operator_spending_policies;
DROP TABLE ledger_entries;

CREATE TABLE ledger_entries (
  entry_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key  TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  agent_id         TEXT    NOT NULL,
  operator_id      TEXT    NOT NULL,
  entry_type       TEXT    NOT NULL,
  from_bucket      TEXT    NOT NULL,
  to_bucket        TEXT    NOT NULL,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency         TEXT    NOT NULL
                   CHECK (length(currency) BETWEEN 3 AND 8 AND currency NOT GLOB '*[^A-Z]*'),
  related_entry_id INTEGER REFERENCES ledger_entries (entry_id) ON DELETE RESTRICT,
  purchase_ref     TEXT    CHECK (purchase_ref IS NULL OR length(purchase_ref) BETWEEN 8 AND 128),
  contribution_id  TEXT,
  version          INTEGER,
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (
       (entry_type = 'operator_funding' AND from_bucket = 'external' AND to_bucket = 'available')
    OR (entry_type IN ('task_earning','tip','contribution_revenue_share')
        AND from_bucket = 'external' AND to_bucket = 'pending')
    OR (entry_type = 'settlement' AND from_bucket = 'pending' AND to_bucket = 'available')
    OR (entry_type = 'reservation' AND from_bucket = 'available' AND to_bucket = 'reserved')
    OR (entry_type = 'reservation_release' AND from_bucket = 'reserved' AND to_bucket = 'available')
    OR (entry_type = 'purchase' AND from_bucket = 'reserved' AND to_bucket = 'spent')
    OR (entry_type = 'fee' AND from_bucket = 'available' AND to_bucket = 'spent')
    OR (entry_type = 'refund' AND from_bucket = 'spent' AND to_bucket = 'available')
    OR (entry_type = 'reversal' AND from_bucket IN ('pending','available') AND to_bucket = 'reversed')
    OR (entry_type = 'withdrawal' AND from_bucket = 'reserved' AND to_bucket = 'withdrawn')
  ),
  CHECK ((contribution_id IS NULL) = (version IS NULL)),
  -- Purchases and revenue shares are always for one exact contribution version.
  CHECK (entry_type NOT IN ('purchase','contribution_revenue_share') OR contribution_id IS NOT NULL),
  -- Moves out of a held or earned amount always name the entry they draw on.
  CHECK (entry_type NOT IN ('settlement','reservation_release','purchase','refund','reversal',
                            'withdrawal','contribution_revenue_share')
         OR related_entry_id IS NOT NULL),
  FOREIGN KEY (agent_id, operator_id) REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_entries_agent_idx ON ledger_entries (agent_id, currency, entry_id);
CREATE INDEX ledger_entries_operator_idx ON ledger_entries (operator_id, currency, created_at);
CREATE INDEX ledger_entries_related_idx ON ledger_entries (related_entry_id);
-- One entry of each type per purchase reference and beneficiary agent: retries cannot duplicate
-- a charge, an earning or a payout.
CREATE UNIQUE INDEX ledger_entries_purchase_uq
  ON ledger_entries (purchase_ref, agent_id, entry_type) WHERE purchase_ref IS NOT NULL;
-- One earning per purchase and beneficiary.
CREATE UNIQUE INDEX ledger_entries_earning_uq
  ON ledger_entries (related_entry_id, agent_id, entry_type)
  WHERE entry_type = 'contribution_revenue_share';

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;

-- No bucket other than `external` may go below zero.
CREATE TRIGGER ledger_entries_no_overdraw BEFORE INSERT ON ledger_entries
WHEN NEW.from_bucket <> 'external'
BEGIN
  SELECT RAISE(ABORT, 'insufficient_balance')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE agent_id = NEW.agent_id AND currency = NEW.currency
           AND to_bucket = NEW.from_bucket)
      - (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE agent_id = NEW.agent_id AND currency = NEW.currency
           AND from_bucket = NEW.from_bucket)
        < NEW.amount_minor;
END;

-- A move that draws on an earlier entry must draw on the right kind of entry, of the same agent
-- (or, for a revenue share, a purchase of the same version) and the same currency.
CREATE TRIGGER ledger_entries_related_valid BEFORE INSERT ON ledger_entries
WHEN NEW.related_entry_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'related_entry_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_entries r
    WHERE r.entry_id = NEW.related_entry_id
      AND r.currency = NEW.currency
      AND (
           (NEW.entry_type IN ('reservation_release','purchase','withdrawal')
            AND r.entry_type = 'reservation' AND r.agent_id = NEW.agent_id)
        OR (NEW.entry_type IN ('settlement','reversal')
            AND r.entry_type IN ('task_earning','tip','contribution_revenue_share')
            AND r.agent_id = NEW.agent_id)
        OR (NEW.entry_type = 'refund' AND r.entry_type = 'purchase' AND r.agent_id = NEW.agent_id)
        OR (NEW.entry_type = 'fee')
        OR (NEW.entry_type = 'contribution_revenue_share' AND r.entry_type = 'purchase'
            AND r.contribution_id = NEW.contribution_id AND r.version = NEW.version)
      )
  );
END;

-- Reservation: releases, purchases and withdrawals together never exceed what was held.
CREATE TRIGGER ledger_entries_reservation_bound BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type IN ('reservation_release','purchase','withdrawal')
BEGIN
  SELECT RAISE(ABORT, 'related_entry_exhausted')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE related_entry_id = NEW.related_entry_id
           AND entry_type IN ('reservation_release','purchase','withdrawal')) + NEW.amount_minor
        > (SELECT amount_minor FROM ledger_entries WHERE entry_id = NEW.related_entry_id);
END;

-- Earning: settled plus reversed-while-pending never exceeds the earning.
CREATE TRIGGER ledger_entries_settlement_bound BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'settlement' OR (NEW.entry_type = 'reversal' AND NEW.from_bucket = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'related_entry_exhausted')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE related_entry_id = NEW.related_entry_id
           AND (entry_type = 'settlement'
                OR (entry_type = 'reversal' AND from_bucket = 'pending'))) + NEW.amount_minor
        > (SELECT amount_minor FROM ledger_entries WHERE entry_id = NEW.related_entry_id);
END;

-- Earning: all reversals together never exceed the earning.
CREATE TRIGGER ledger_entries_reversal_bound BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reversal'
BEGIN
  SELECT RAISE(ABORT, 'related_entry_exhausted')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE related_entry_id = NEW.related_entry_id AND entry_type = 'reversal')
        + NEW.amount_minor
        > (SELECT amount_minor FROM ledger_entries WHERE entry_id = NEW.related_entry_id);
END;

-- Purchase: refunds never exceed the purchase.
CREATE TRIGGER ledger_entries_refund_bound BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'refund'
BEGIN
  SELECT RAISE(ABORT, 'related_entry_exhausted')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE related_entry_id = NEW.related_entry_id AND entry_type = 'refund')
        + NEW.amount_minor
        > (SELECT amount_minor FROM ledger_entries WHERE entry_id = NEW.related_entry_id);
END;

-- A revenue share goes only to the contribution's own contributor agent, and only from a purchase
-- by a different operator: self-purchases never earn.
CREATE TRIGGER ledger_entries_revenue_share_eligible BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'contribution_revenue_share'
BEGIN
  SELECT RAISE(ABORT, 'earning_not_eligible')
  WHERE NOT EXISTS (
    SELECT 1 FROM contributions c, ledger_entries p
    WHERE c.id = NEW.contribution_id
      AND c.contributor_agent_id = NEW.agent_id
      AND c.contributor_operator_id = NEW.operator_id
      AND p.entry_id = NEW.related_entry_id
      AND p.operator_id <> c.contributor_operator_id
  );
END;

-- ===================== Operator spending controls =====================

CREATE TABLE operator_spending_policies (
  policy_id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id                  TEXT    NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  currency                     TEXT    NOT NULL
                               CHECK (length(currency) BETWEEN 3 AND 8 AND currency NOT GLOB '*[^A-Z]*'),
  per_transaction_limit_minor  INTEGER NOT NULL CHECK (per_transaction_limit_minor >= 0),
  daily_limit_minor            INTEGER NOT NULL CHECK (daily_limit_minor >= 0),
  monthly_limit_minor          INTEGER NOT NULL CHECK (monthly_limit_minor >= 0),
  minimum_reserve_minor        INTEGER NOT NULL CHECK (minimum_reserve_minor >= 0),
  max_autonomous_balance_minor INTEGER NOT NULL CHECK (max_autonomous_balance_minor >= 0),
  permitted_categories_json    TEXT    NOT NULL
                               CHECK (json_valid(permitted_categories_json)
                                      AND json_type(permitted_categories_json) = 'array'),
  withdrawals_need_approval    INTEGER NOT NULL DEFAULT 1 CHECK (withdrawals_need_approval IN (0,1)),
  set_by                       TEXT    NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  effective_at                 TEXT    NOT NULL CHECK (effective_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (per_transaction_limit_minor <= daily_limit_minor
         AND daily_limit_minor <= monthly_limit_minor)
) STRICT;
CREATE INDEX operator_spending_policies_operator_idx
  ON operator_spending_policies (operator_id, currency, policy_id);

CREATE TRIGGER operator_spending_policies_no_update BEFORE UPDATE ON operator_spending_policies
BEGIN SELECT RAISE(ABORT, 'operator_spending_policies is append-only'); END;
CREATE TRIGGER operator_spending_policies_no_delete BEFORE DELETE ON operator_spending_policies
BEGIN SELECT RAISE(ABORT, 'operator_spending_policies is append-only'); END;

-- A suspended agent or operator can neither reserve funds nor withdraw.
CREATE TRIGGER ledger_entries_not_suspended BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type IN ('reservation','withdrawal')
BEGIN
  SELECT RAISE(ABORT, 'spending_suspended')
  WHERE EXISTS (SELECT 1 FROM operators WHERE id = NEW.operator_id AND status <> 'active')
     OR EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND status <> 'active')
     OR (SELECT action FROM spending_suspensions
         WHERE operator_id = NEW.operator_id AND agent_id IS NULL
         ORDER BY suspension_id DESC LIMIT 1) = 'suspend'
     OR (SELECT action FROM spending_suspensions
         WHERE operator_id = NEW.operator_id AND agent_id = NEW.agent_id
         ORDER BY suspension_id DESC LIMIT 1) = 'suspend';
END;

-- A purchase reservation must fit the operator's latest policy for that currency. Period limits
-- count every agent of the operator, so spreading purchases across agents cannot bypass them.
-- Days and months are UTC calendar periods of the reservation's own timestamp. Released amounts
-- no longer count toward the period of the reservation they came from.
CREATE TRIGGER ledger_entries_policy_required BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'spending_policy_missing')
  WHERE NOT EXISTS (SELECT 1 FROM operator_spending_policies
                    WHERE operator_id = NEW.operator_id AND currency = NEW.currency);
END;

CREATE TRIGGER ledger_entries_category_permitted BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM operator_spending_policies
             WHERE operator_id = NEW.operator_id AND currency = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'category_not_permitted')
  WHERE NOT EXISTS (
    SELECT 1
    FROM contribution_versions v,
         json_each((SELECT permitted_categories_json FROM operator_spending_policies
                    WHERE operator_id = NEW.operator_id AND currency = NEW.currency
                    ORDER BY policy_id DESC LIMIT 1)) c
    WHERE v.contribution_id = NEW.contribution_id AND v.version = NEW.version
      AND (c.value = v.family OR c.value = v.family || ':' || v.content_type)
  );
END;

CREATE TRIGGER ledger_entries_per_transaction_limit BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'per_transaction_limit')
  WHERE NEW.amount_minor > (SELECT per_transaction_limit_minor FROM operator_spending_policies
                            WHERE operator_id = NEW.operator_id AND currency = NEW.currency
                            ORDER BY policy_id DESC LIMIT 1);
END;

CREATE TRIGGER ledger_entries_daily_limit BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'daily_limit')
  WHERE NEW.amount_minor + (
          SELECT COALESCE(SUM(r.amount_minor - COALESCE(
                   (SELECT SUM(x.amount_minor) FROM ledger_entries x
                    WHERE x.related_entry_id = r.entry_id
                      AND x.entry_type = 'reservation_release'), 0)), 0)
          FROM ledger_entries r
          WHERE r.operator_id = NEW.operator_id AND r.currency = NEW.currency
            AND r.entry_type = 'reservation' AND r.contribution_id IS NOT NULL
            AND substr(r.created_at, 1, 10) = substr(NEW.created_at, 1, 10))
        > (SELECT daily_limit_minor FROM operator_spending_policies
           WHERE operator_id = NEW.operator_id AND currency = NEW.currency
           ORDER BY policy_id DESC LIMIT 1);
END;

CREATE TRIGGER ledger_entries_monthly_limit BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'monthly_limit')
  WHERE NEW.amount_minor + (
          SELECT COALESCE(SUM(r.amount_minor - COALESCE(
                   (SELECT SUM(x.amount_minor) FROM ledger_entries x
                    WHERE x.related_entry_id = r.entry_id
                      AND x.entry_type = 'reservation_release'), 0)), 0)
          FROM ledger_entries r
          WHERE r.operator_id = NEW.operator_id AND r.currency = NEW.currency
            AND r.entry_type = 'reservation' AND r.contribution_id IS NOT NULL
            AND substr(r.created_at, 1, 7) = substr(NEW.created_at, 1, 7))
        > (SELECT monthly_limit_minor FROM operator_spending_policies
           WHERE operator_id = NEW.operator_id AND currency = NEW.currency
           ORDER BY policy_id DESC LIMIT 1);
END;

-- Only when the amount is otherwise covered: an uncovered amount is `insufficient_balance`.
CREATE TRIGGER ledger_entries_minimum_reserve BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'reservation' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'minimum_reserve')
  WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE agent_id = NEW.agent_id AND currency = NEW.currency AND to_bucket = 'available')
      - (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
         WHERE agent_id = NEW.agent_id AND currency = NEW.currency AND from_bucket = 'available')
        BETWEEN NEW.amount_minor
            AND NEW.amount_minor
                + (SELECT minimum_reserve_minor FROM operator_spending_policies
                   WHERE operator_id = NEW.operator_id AND currency = NEW.currency
                   ORDER BY policy_id DESC LIMIT 1) - 1;
END;

-- ===================== Contribution revenue share =====================

-- The contributor earns half of the purchase amount, rounded down; the platform keeps the rest.
CREATE TRIGGER ledger_entries_revenue_share_amount BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'contribution_revenue_share'
BEGIN
  SELECT RAISE(ABORT, 'earning_amount_invalid')
  WHERE NEW.amount_minor <> (SELECT (amount_minor * 50) / 100 FROM ledger_entries
                             WHERE entry_id = NEW.related_entry_id);
END;

-- The family success test: Knowledge verified by the platform; Execution reported successful by
-- the operator that bought it.
CREATE TRIGGER ledger_entries_revenue_share_test BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'contribution_revenue_share'
BEGIN
  SELECT RAISE(ABORT, 'earning_test_not_met')
  WHERE NOT EXISTS (
    SELECT 1 FROM contribution_versions v, ledger_entries p
    WHERE v.contribution_id = NEW.contribution_id AND v.version = NEW.version
      AND p.entry_id = NEW.related_entry_id
      AND (
           (v.family = 'knowledge'
            AND EXISTS (SELECT 1 FROM version_trust t
                        WHERE t.contribution_id = v.contribution_id AND t.version = v.version
                          AND t.verified = 1))
        OR (v.family = 'execution'
            AND EXISTS (SELECT 1 FROM feedback_reports f
                        WHERE f.consumer_operator_id = p.operator_id
                          AND f.contribution_id = v.contribution_id AND f.version = v.version
                          AND f.dimension = 'outcome'
                          AND json_extract(f.assessment_json, '$.finding') = 'success'))
      )
  );
END;
