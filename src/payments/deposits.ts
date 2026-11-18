/**
 * USDC deposits verified on Base (Phase 6; Base Sepolia test USDC first).
 *
 * An operator sends USDC from its enrolled wallet to the platform's deposit address, then one of
 * its agents claims the transaction. A transfer is credited only when every check passes:
 *
 * - the RPC endpoint reports the configured chain (no wrong-network credit);
 * - the transaction succeeded, and its block is still canonical (reorg check) with enough
 *   confirmations on top;
 * - the log is a Transfer from the official USDC contract (no fake tokens) to the platform's
 *   deposit address, from the wallet enrolled for the claiming agent's operator (nobody can claim
 *   another operator's transfer);
 * - the amount is at least the minimum deposit (no dust) and within the ledger's bounds.
 *
 * Each matching log is credited once, as `operator_funding` to the claiming agent, together with
 * an append-only `chain_deposits` row (migration 0020), in one D1 batch. Claiming again returns
 * the stored result.
 */
import { ledgerRefusalOf } from "./ledger";
import { PAYMENT_CURRENCY } from "./pricing";
import {
  ChainReader,
  hexInt,
  TRANSFER_TOPIC,
  topicAddress,
  wordAmount,
  type NetworkConfig,
} from "./chain";

/** Smallest deposit credited: 0.01 USDC. Smaller transfers are dust and are not credited. */
export const MIN_DEPOSIT_MINOR = 10_000;
const MAX_AMOUNT = 1_000_000_000_000n;
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface DepositClaim {
  readonly agentId: string;
  readonly operatorId: string;
  readonly txHash: string;
}

export interface CreditedLog {
  readonly logIndex: number;
  readonly amountMinor: number;
  readonly ledgerEntryId: number;
}

export type DepositOutcome =
  | {
      readonly ok: true;
      readonly status: "credited" | "already_credited";
      readonly credited: readonly CreditedLog[];
      readonly amountMinor: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "not_enrolled"
        | "wrong_network"
        | "deposit_not_found"
        | "deposit_failed"
        | "deposit_unconfirmed"
        | "not_a_deposit"
        | "deposit_not_yours"
        | "deposit_too_small"
        | "chain_unavailable"
        | "payments_stopped";
      readonly confirmations?: { readonly have: number; readonly need: number };
    };

interface StoredRow {
  log_index: number;
  amount_minor: number;
  ledger_entry_id: number;
  operator_id: string;
}

export class DepositService {
  constructor(
    private readonly db: D1Database,
    private readonly network: NetworkConfig,
    private readonly depositAddress: string,
    private readonly chain: ChainReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(claim: DepositClaim): Promise<DepositOutcome> {
    const txHash = claim.txHash.toLowerCase();
    const wallet = await this.db
      .prepare("SELECT address FROM wallet_accounts WHERE operator_id = ?")
      .bind(claim.operatorId)
      .first<{ address: string }>();
    if (!wallet) return { ok: false, code: "not_enrolled" };

    const stored = await this.stored(txHash);
    if (stored.length > 0) {
      if (stored.some((r) => r.operator_id !== claim.operatorId)) {
        return { ok: false, code: "deposit_not_yours" };
      }
      return this.done("already_credited", stored);
    }

    let checked: Awaited<ReturnType<DepositService["verify"]>>;
    try {
      checked = await this.verify(txHash, wallet.address);
    } catch {
      return { ok: false, code: "chain_unavailable" };
    }
    if (!checked.ok) return checked;

    const at = this.now().toISOString();
    const statements = checked.logs.flatMap((log) => {
      const key = `deposit:${this.network.chainId}:${txHash}:${log.logIndex}`;
      return [
        this.db
          .prepare(
            `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
               from_bucket, to_bucket, amount_minor, currency, created_at)
             VALUES (?, ?, ?, 'operator_funding', 'external', 'available', ?, ?, ?)`,
          )
          .bind(key, claim.agentId, claim.operatorId, log.amount, PAYMENT_CURRENCY, at),
        this.db
          .prepare(
            `INSERT INTO chain_deposits (chain_id, tx_hash, log_index, token_address, from_address,
               to_address, amount_minor, block_number, block_hash, ledger_entry_id, credited_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?)`,
          )
          .bind(
            this.network.chainId,
            txHash,
            log.logIndex,
            this.network.usdc,
            wallet.address,
            this.depositAddress,
            log.amount,
            checked.blockNumber,
            checked.blockHash,
            key,
            at,
          ),
      ];
    });
    try {
      await this.db.batch(statements);
    } catch (error) {
      // A concurrent claim of the same transfer recorded it first.
      const raced = await this.stored(txHash);
      if (raced.length > 0) {
        return raced.some((r) => r.operator_id !== claim.operatorId)
          ? { ok: false, code: "deposit_not_yours" }
          : this.done("already_credited", raced);
      }
      if (ledgerRefusalOf(error) === "payments_stopped") {
        return { ok: false, code: "payments_stopped" };
      }
      throw error;
    }
    return this.done("credited", await this.stored(txHash));
  }

  private done(
    status: "credited" | "already_credited",
    rows: readonly StoredRow[],
  ): DepositOutcome {
    const credited = rows.map((r) => ({
      logIndex: r.log_index,
      amountMinor: r.amount_minor,
      ledgerEntryId: r.ledger_entry_id,
    }));
    return {
      ok: true,
      status,
      credited,
      amountMinor: credited.reduce((n, c) => n + c.amountMinor, 0),
    };
  }

  private async stored(txHash: string): Promise<StoredRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT d.log_index, d.amount_minor, d.ledger_entry_id, e.operator_id
         FROM chain_deposits d JOIN ledger_entries e ON e.entry_id = d.ledger_entry_id
         WHERE d.chain_id = ? AND d.tx_hash = ? ORDER BY d.log_index`,
      )
      .bind(this.network.chainId, txHash)
      .all<StoredRow>();
    return results;
  }

  private async verify(txHash: string, wallet: string) {
    const fail = (code: Extract<DepositOutcome, { ok: false }>["code"]) =>
      ({ ok: false, code }) as const;
    if ((await this.chain.chainId()) !== this.network.chainId) return fail("wrong_network");
    const receipt = await this.chain.receipt(txHash);
    if (!receipt || receipt.transactionHash?.toLowerCase() !== txHash) {
      return fail("deposit_not_found");
    }
    if (receipt.status !== "0x1") return fail("deposit_failed");
    const blockNumber = hexInt(receipt.blockNumber);
    const head = await this.chain.blockNumber();
    if (blockNumber === null || head === null) return fail("chain_unavailable");
    const have = head - blockNumber + 1;
    if (have < this.network.confirmations) {
      return {
        ok: false,
        code: "deposit_unconfirmed",
        confirmations: { have: Math.max(0, have), need: this.network.confirmations },
      } as const;
    }
    const blockHash = String(receipt.blockHash).toLowerCase();
    if ((await this.chain.blockHash(blockNumber)) !== blockHash) {
      return fail("deposit_not_found");
    }

    const toPlatform = receipt.logs.filter(
      (log) =>
        String(log.address).toLowerCase() === this.network.usdc &&
        log.topics?.[0] === TRANSFER_TOPIC &&
        topicAddress(log.topics?.[2]) === this.depositAddress,
    );
    if (toPlatform.length === 0) return fail("not_a_deposit");
    const mine = toPlatform.filter((log) => topicAddress(log.topics?.[1]) === wallet);
    if (mine.length === 0) return fail("deposit_not_yours");

    const logs: { logIndex: number; amount: number }[] = [];
    for (const log of mine) {
      const amount = wordAmount(log.data);
      const logIndex = hexInt(log.logIndex);
      if (amount === null || logIndex === null || amount > MAX_AMOUNT) return fail("not_a_deposit");
      if (amount < BigInt(MIN_DEPOSIT_MINOR)) continue;
      logs.push({ logIndex, amount: Number(amount) });
    }
    if (logs.length === 0) return fail("deposit_too_small");
    return { ok: true, logs, blockNumber, blockHash } as const;
  }
}
