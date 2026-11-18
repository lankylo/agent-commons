-- Migration 0018: Execution verification reward and verified-only contributor earnings (Phase 6,
-- no live money).
--
-- Owner decision (2026-11-18): an unverified Execution version is free and earns its contributor
-- nothing. The first two independent operators whose successful outcome reports make it verified
-- share a one-time platform-paid reward of 0.05 USDC: 25,000 USDC base units each, recorded as a
-- pending `task_earning` that names the version. Once verified, it is sold at its price and the
-- contributor earns its share of each independent purchase.
--
-- 1. The revenue-share success test (migration 0016) becomes the same for both families: the
--    version must be verified by the platform.
-- 2. A verification reward must be exactly 25,000 USDC units, go to the agent that reported the
--    successful outcome, from an operator other than the contributor's, for a verified Execution
--    version; at most two per version, one per operator, and at most 20 per operator per UTC day.
-- Each trigger body holds one statement.

DROP TRIGGER ledger_entries_revenue_share_test;

CREATE TRIGGER ledger_entries_revenue_share_test BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'contribution_revenue_share'
BEGIN
  SELECT RAISE(ABORT, 'earning_test_not_met')
  WHERE NOT EXISTS (SELECT 1 FROM version_trust t
                    WHERE t.contribution_id = NEW.contribution_id AND t.version = NEW.version
                      AND t.verified = 1);
END;

-- One reward per operator and version.
CREATE UNIQUE INDEX ledger_entries_reward_uq
  ON ledger_entries (contribution_id, version, operator_id)
  WHERE entry_type = 'task_earning' AND contribution_id IS NOT NULL;

CREATE TRIGGER ledger_entries_verification_reward_eligible BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'task_earning' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward_not_eligible')
  WHERE NEW.amount_minor <> 25000
     OR NEW.currency <> 'USDC'
     OR NOT EXISTS (
       SELECT 1
       FROM contribution_versions v
       JOIN contributions c ON c.id = v.contribution_id
       JOIN version_trust t ON t.contribution_id = v.contribution_id AND t.version = v.version
       JOIN feedback_reports f ON f.contribution_id = v.contribution_id AND f.version = v.version
       WHERE v.contribution_id = NEW.contribution_id AND v.version = NEW.version
         AND v.family = 'execution'
         AND t.verified = 1
         AND c.contributor_operator_id <> NEW.operator_id
         AND f.consumer_operator_id = NEW.operator_id
         AND f.agent_id = NEW.agent_id
         AND f.dimension = 'outcome'
         AND json_extract(f.assessment_json, '$.finding') = 'success'
     );
END;

CREATE TRIGGER ledger_entries_verification_reward_limit BEFORE INSERT ON ledger_entries
WHEN NEW.entry_type = 'task_earning' AND NEW.contribution_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward_limit')
  WHERE (SELECT COUNT(*) FROM ledger_entries
         WHERE entry_type = 'task_earning' AND contribution_id = NEW.contribution_id
           AND version = NEW.version) >= 2
     OR (SELECT COUNT(*) FROM ledger_entries
         WHERE entry_type = 'task_earning' AND contribution_id IS NOT NULL
           AND operator_id = NEW.operator_id
           AND substr(created_at, 1, 10) = substr(NEW.created_at, 1, 10)) >= 20;
END;
