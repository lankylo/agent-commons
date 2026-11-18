/**
 * Payouts of available USDC to the operator's enrolled wallet (Phase 6; Base Sepolia first).
 *
 * The Worker never holds a key or sends money:
 *
 * 1. An agent requests a payout; the amount moves from available to reserved and the request names
 *    its operator's enrolled wallet as the only possible destination.
 * 2. The operator approves or rejects it by wallet signature, unless its spending policy says
 *    withdrawals need no approval, in which case it is approved at once.
 * 3. The owner sends the USDC from the platform wallet and records the transaction hash. The
 *    Worker verifies the transfer on-chain (network, success, canonical block, confirmations,
 *    official token, from the platform wallet, to the destination, exact amount) and only then
 *    records the withdrawal. A rejection releases the reserved amount.
 *
 * D1 (migration 0022) keeps requests and events append-only, ties every closing event to the
 * ledger entry that settles the reservation, and lets one transfer pay one payout only.
 */
import {
  ChainReader,
  hexInt,
  TRANSFER_TOPIC,
  topicAddress,
  wordAmount,
  type NetworkConfig,
} from "./chain";
import { Ledger } from "./ledger";
import { PAYMENT_CURRENCY } from "./pricing";
import { SpendingControls } from "./spending-controls";

/** Smallest payout: 1 USDC, so network fees stay small relative to the amount. */
export const MIN_PAYOUT_MINOR = 1_000_000;
const MAX_AMOUNT = 1_000_000_000_000;
const KEY = /^[\w:.-]{8,128}$/;

export type PayoutStatus = "awaiting_approval" | "approved" | "sent" | "rejected" | "cancelled";

export interface PayoutView {
  readonly requestId: number;
  readonly agentId: string;
  readonly operatorId: string;
  readonly destination: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: PayoutStatus;
  readonly requestedAt: string;
  readonly txHash: string | null;
}

export type PayoutRefusal =
  | "invalid_request"
  | "not_enrolled"
  | "spending_policy_missing"
  | "insufficient_balance"
  | "minimum_reserve"
  | "spending_suspended"
  | "payments_stopped"
  | "not_found"
  | "not_awaiting_approval"
  | "not_approved"
  | "wrong_network"
  | "transfer_not_found"
  | "transfer_failed"
  | "transfer_unconfirmed"
  | "transfer_mismatch"
  | "transfer_already_used"
  | "chain_unavailable";

export type PayoutResult =
  | { readonly ok: true; readonly payout: PayoutView; readonly replayed?: boolean }
  | { readonly ok: false; readonly code: PayoutRefusal };

const VIEW_SQL = `SELECT p.request_id, p.agent_id, p.operator_id, p.destination, p.amount_minor,
    p.currency, p.requested_at,
    (SELECT e.event FROM payout_events e WHERE e.request_id = p.request_id
     ORDER BY e.event_id DESC LIMIT 1) AS last_event,
    (SELECT e.tx_hash FROM payout_events e WHERE e.request_id = p.request_id
       AND e.event = 'sent') AS tx_hash
  FROM payout_requests p`;

interface ViewRow {
  request_id: number;
  agent_id: string;
  operator_id: string;
  destination: string;
  amount_minor: number;
  currency: string;
  requested_at: string;
  last_event: string | null;
  tx_hash: string | null;
}

const toView = (r: ViewRow): PayoutView => ({
  requestId: r.request_id,
  agentId: r.agent_id,
  operatorId: r.operator_id,
  destination: r.destination,
  amountMinor: r.amount_minor,
  currency: r.currency,
  status: (r.last_event ?? "awaiting_approval") as PayoutStatus,
  requestedAt: r.requested_at,
  txHash: r.tx_hash,
});

function refusalOf(error: unknown): PayoutRefusal | null {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  for (const code of ["insufficient_balance", "spending_suspended", "payments_stopped"] as const) {
    if (message.includes(code)) return code;
  }
  if (message.includes("payout_events.tx_hash") || message.includes("payout_events_tx_uq")) {
    return "transfer_already_used";
  }
  return null;
}

export class PayoutService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(requestId: number): Promise<PayoutView | null> {
    const row = await this.db
      .prepare(`${VIEW_SQL} WHERE p.request_id = ?`)
      .bind(requestId)
      .first<ViewRow>();
    return row ? toView(row) : null;
  }

  /** The agent's latest payout requests, newest first. */
  async forAgent(agentId: string, limit = 20): Promise<PayoutView[]> {
    const { results } = await this.db
      .prepare(`${VIEW_SQL} WHERE p.agent_id = ? ORDER BY p.request_id DESC LIMIT ?`)
      .bind(agentId, limit)
      .all<ViewRow>();
    return results.map(toView);
  }

  /** Approved payouts the owner still has to send, oldest first. */
  async toSend(limit = 100): Promise<PayoutView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM (${VIEW_SQL}) WHERE last_event = 'approved'
                ORDER BY request_id LIMIT ?`,
      )
      .bind(limit)
      .all<ViewRow>();
    return results.map(toView);
  }

  async request(input: {
    readonly agentId: string;
    readonly operatorId: string;
    readonly amountMinor: number;
    readonly idempotencyKey: string;
  }): Promise<PayoutResult> {
    const amount = input.amountMinor;
    if (
      !Number.isSafeInteger(amount) ||
      amount < MIN_PAYOUT_MINOR ||
      amount > MAX_AMOUNT ||
      typeof input.idempotencyKey !== "string" ||
      !KEY.test(input.idempotencyKey)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    const key = `payout:${input.agentId}:${input.idempotencyKey}`;
    const existing = await this.db
      .prepare(
        `SELECT p.request_id FROM payout_requests p
         JOIN ledger_entries e ON e.entry_id = p.reservation_entry_id
         WHERE e.idempotency_key = ?`,
      )
      .bind(key)
      .first<{ request_id: number }>();
    if (existing) {
      const payout = await this.get(existing.request_id);
      if (payout && payout.agentId === input.agentId && payout.amountMinor === amount) {
        return { ok: true, payout, replayed: true };
      }
      return { ok: false, code: "invalid_request" };
    }

    const wallet = await this.db
      .prepare("SELECT address FROM wallet_accounts WHERE operator_id = ?")
      .bind(input.operatorId)
      .first<{ address: string }>();
    if (!wallet) return { ok: false, code: "not_enrolled" };
    const policy = await new SpendingControls(this.db, this.now).currentPolicy(
      input.operatorId,
      PAYMENT_CURRENCY,
    );
    if (!policy) return { ok: false, code: "spending_policy_missing" };
    const available = (await new Ledger(this.db).balances(input.agentId))[PAYMENT_CURRENCY]
      ?.available;
    if ((available ?? 0) < amount) return { ok: false, code: "insufficient_balance" };
    if ((available ?? 0) - amount < policy.minimumReserveMinor) {
      return { ok: false, code: "minimum_reserve" };
    }

    const at = this.now().toISOString();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
             from_bucket, to_bucket, amount_minor, currency, created_at)
           VALUES (?, ?, ?, 'reservation', 'available', 'reserved', ?, ?, ?)`,
        )
        .bind(key, input.agentId, input.operatorId, amount, PAYMENT_CURRENCY, at),
      this.db
        .prepare(
          `INSERT INTO payout_requests (operator_id, agent_id, destination, amount_minor, currency,
             reservation_entry_id, requested_at)
           VALUES (?, ?, ?, ?, ?, (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?)`,
        )
        .bind(input.operatorId, input.agentId, wallet.address, amount, PAYMENT_CURRENCY, key, at),
    ];
    if (!policy.withdrawalsNeedApproval) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO payout_events (request_id, event, reason, set_by, created_at)
             VALUES ((SELECT p.request_id FROM payout_requests p
                      JOIN ledger_entries e ON e.entry_id = p.reservation_entry_id
                      WHERE e.idempotency_key = ?),
                     'approved', 'Operator policy: withdrawals need no approval', 'policy', ?)`,
          )
          .bind(key, at),
      );
    }
    try {
      await this.db.batch(statements);
    } catch (error) {
      const code = refusalOf(error);
      if (code) return { ok: false, code };
      throw error;
    }
    const created = await this.db
      .prepare(
        `SELECT p.request_id FROM payout_requests p
         JOIN ledger_entries e ON e.entry_id = p.reservation_entry_id
         WHERE e.idempotency_key = ?`,
      )
      .bind(key)
      .first<{ request_id: number }>();
    return { ok: true, payout: (await this.get(created!.request_id))! };
  }

  /** The operator's decision on a request that awaits approval (by wallet signature). */
  async decide(
    operatorId: string,
    requestId: number,
    approve: boolean,
    setBy: string,
  ): Promise<PayoutResult> {
    const payout = await this.get(requestId);
    if (!payout || payout.operatorId !== operatorId) return { ok: false, code: "not_found" };
    if (payout.status !== "awaiting_approval") return { ok: false, code: "not_awaiting_approval" };
    if (approve) {
      await this.db
        .prepare(
          `INSERT INTO payout_events (request_id, event, reason, set_by, created_at)
           VALUES (?, 'approved', 'Approved by the operator wallet', ?, ?)`,
        )
        .bind(requestId, setBy, this.now().toISOString())
        .run();
      return { ok: true, payout: (await this.get(requestId))! };
    }
    return this.close(payout, "rejected", "Rejected by the operator wallet", setBy);
  }

  /** Rejects an open request (operator before approval, or the owner before sending). */
  async reject(requestId: number, reason: string, setBy: string): Promise<PayoutResult> {
    const payout = await this.get(requestId);
    if (!payout) return { ok: false, code: "not_found" };
    if (payout.status !== "awaiting_approval" && payout.status !== "approved") {
      return { ok: false, code: "not_awaiting_approval" };
    }
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500) {
      return { ok: false, code: "invalid_request" };
    }
    return this.close(payout, "rejected", reason, setBy);
  }

  private async close(
    payout: PayoutView,
    event: "rejected" | "cancelled",
    reason: string,
    setBy: string,
  ): Promise<PayoutResult> {
    const at = this.now().toISOString();
    const key = `payout:${payout.requestId}:${event}`;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
               from_bucket, to_bucket, amount_minor, currency, related_entry_id, created_at)
             SELECT ?, p.agent_id, p.operator_id, 'reservation_release', 'reserved', 'available',
                    p.amount_minor, p.currency, p.reservation_entry_id, ?
             FROM payout_requests p WHERE p.request_id = ?`,
          )
          .bind(key, at, payout.requestId),
        this.db
          .prepare(
            `INSERT INTO payout_events (request_id, event, ledger_entry_id, reason, set_by,
               created_at)
             VALUES (?, ?, (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?, ?, ?)`,
          )
          .bind(payout.requestId, event, key, reason, setBy, at),
      ]);
    } catch (error) {
      const code = refusalOf(error);
      if (code) return { ok: false, code };
      throw error;
    }
    return { ok: true, payout: (await this.get(payout.requestId))! };
  }

  /**
   * Records an approved payout as sent once its on-chain transfer checks out: a USDC Transfer
   * from the platform wallet to the request's destination, for exactly the requested amount.
   */
  async recordSent(input: {
    readonly requestId: number;
    readonly txHash: string;
    readonly network: NetworkConfig;
    readonly platformAddress: string;
    readonly chain: ChainReader;
    readonly setBy: string;
  }): Promise<PayoutResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) return { ok: false, code: "invalid_request" };
    const txHash = input.txHash.toLowerCase();
    const payout = await this.get(input.requestId);
    if (!payout) return { ok: false, code: "not_found" };
    if (payout.status !== "approved") return { ok: false, code: "not_approved" };

    let verified: PayoutRefusal | null;
    try {
      verified = await verifyTransfer(input, txHash, payout);
    } catch {
      return { ok: false, code: "chain_unavailable" };
    }
    if (verified) return { ok: false, code: verified };

    const at = this.now().toISOString();
    const key = `payout:${payout.requestId}:sent`;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
               from_bucket, to_bucket, amount_minor, currency, related_entry_id, created_at)
             SELECT ?, p.agent_id, p.operator_id, 'withdrawal', 'reserved', 'withdrawn',
                    p.amount_minor, p.currency, p.reservation_entry_id, ?
             FROM payout_requests p WHERE p.request_id = ?`,
          )
          .bind(key, at, payout.requestId),
        this.db
          .prepare(
            `INSERT INTO payout_events (request_id, event, tx_hash, ledger_entry_id, reason, set_by,
               created_at)
             VALUES (?, 'sent', ?, (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?),
                     'Transfer verified on-chain', ?, ?)`,
          )
          .bind(payout.requestId, txHash, key, input.setBy, at),
      ]);
    } catch (error) {
      const code = refusalOf(error);
      if (code) return { ok: false, code };
      throw error;
    }
    return { ok: true, payout: (await this.get(payout.requestId))! };
  }
}

async function verifyTransfer(
  input: {
    readonly network: NetworkConfig;
    readonly platformAddress: string;
    readonly chain: ChainReader;
  },
  txHash: string,
  payout: PayoutView,
): Promise<PayoutRefusal | null> {
  const { chain, network } = input;
  if ((await chain.chainId()) !== network.chainId) return "wrong_network";
  const receipt = await chain.receipt(txHash);
  if (!receipt || String(receipt.transactionHash).toLowerCase() !== txHash) {
    return "transfer_not_found";
  }
  if (receipt.status !== "0x1") return "transfer_failed";
  const block = hexInt(receipt.blockNumber);
  const head = await chain.blockNumber();
  if (block === null || head === null) return "chain_unavailable";
  if (head - block + 1 < network.confirmations) return "transfer_unconfirmed";
  if ((await chain.blockHash(block)) !== String(receipt.blockHash).toLowerCase()) {
    return "transfer_not_found";
  }
  const matches = receipt.logs.some(
    (log) =>
      String(log.address).toLowerCase() === network.usdc &&
      log.topics?.[0] === TRANSFER_TOPIC &&
      topicAddress(log.topics?.[1]) === input.platformAddress &&
      topicAddress(log.topics?.[2]) === payout.destination &&
      wordAmount(log.data) === BigInt(payout.amountMinor),
  );
  return matches ? null : "transfer_mismatch";
}
