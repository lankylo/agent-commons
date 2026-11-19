/**
 * Read-only access to Base over JSON-RPC, for verifying USDC deposits (Phase 6). The Worker never
 * signs, holds a key or sends a transaction: it only reads receipts, block numbers and blocks.
 *
 * Networks are fixed here, not taken from requests. The USDC token addresses are Circle's
 * published contracts; confirm them against Circle's documentation before real money.
 */
export type DepositNetwork = "base-sepolia" | "base";

export interface NetworkConfig {
  readonly network: DepositNetwork;
  readonly chainId: number;
  /** USDC token contract, lower-case. */
  readonly usdc: string;
  readonly defaultRpcUrl: string;
  /** Blocks on top of the deposit's block (inclusive) before it is credited. */
  readonly confirmations: number;
  /** False until the owner switches on real money. */
  readonly enabled: boolean;
}

export const NETWORKS: Readonly<Record<DepositNetwork, NetworkConfig>> = Object.freeze({
  "base-sepolia": {
    network: "base-sepolia",
    chainId: 84532,
    usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    defaultRpcUrl: "https://sepolia.base.org",
    confirmations: 3,
    enabled: true,
  },
  base: {
    network: "base",
    chainId: 8453,
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    defaultRpcUrl: "https://mainnet.base.org",
    confirmations: 12,
    enabled: false,
  },
});

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: string;
}

export interface Receipt {
  readonly status: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logs: readonly ReceiptLog[];
}

/** Minimal JSON-RPC transport; tests inject a fake. */
export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

export class RpcError extends Error {}

export function httpRpc(
  url: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): RpcCall {
  let id = 0;
  return async (method, params) => {
    // Workers reject redirect: "error"; "manual" returns a 3xx, which fails the ok check below.
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      redirect: "manual",
    });
    if (!response.ok) throw new RpcError(`rpc http ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new RpcError("rpc error");
    return body.result ?? null;
  };
}

const HEX = /^0x[0-9a-fA-F]+$/;
const hexInt = (value: unknown): number | null =>
  typeof value === "string" && HEX.test(value) && value.length <= 18 ? Number(BigInt(value)) : null;

export class ChainReader {
  constructor(private readonly rpc: RpcCall) {}

  async chainId(): Promise<number | null> {
    return hexInt(await this.rpc("eth_chainId", []));
  }

  async blockNumber(): Promise<number | null> {
    return hexInt(await this.rpc("eth_blockNumber", []));
  }

  async receipt(txHash: string): Promise<Receipt | null> {
    const r = (await this.rpc("eth_getTransactionReceipt", [txHash])) as Receipt | null;
    if (!r || typeof r !== "object" || !Array.isArray(r.logs)) return null;
    return r;
  }

  /** ERC-20 balance of `holder` in base units (`balanceOf`), or null when unreadable. */
  async tokenBalance(token: string, holder: string): Promise<bigint | null> {
    const data = `0x70a08231${"0".repeat(24)}${holder.slice(2).toLowerCase()}`;
    const result = await this.rpc("eth_call", [{ to: token, data }, "latest"]);
    return typeof result === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(result)
      ? BigInt(result)
      : null;
  }

  /** Hash of the canonical block at `number`, or null when unknown. */
  async blockHash(number: number): Promise<string | null> {
    const block = (await this.rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as {
      hash?: unknown;
    } | null;
    return typeof block?.hash === "string" ? block.hash.toLowerCase() : null;
  }
}

/** The 20-byte address in a 32-byte topic, lower-case, or null. */
export function topicAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/** A uint256 log data word as a bigint, or null. */
export function wordAmount(data: unknown): bigint | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return BigInt(data);
}

export { hexInt };
