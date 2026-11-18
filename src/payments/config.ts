/**
 * Chain configuration shared by deposits and payouts (Phase 6). Both use the same network and the
 * same platform wallet: deposits arrive at it, payouts are sent from it by the owner.
 */
import { NETWORKS, type NetworkConfig, type RpcCall } from "./chain";
import { resolvePaymentsMode } from "./provider";

export interface ChainEnv {
  /** "off" (default) or "base-sepolia"; needs PAYMENTS "sandbox". */
  readonly DEPOSITS?: string;
  /** The platform's public wallet address (never a key). */
  readonly DEPOSIT_ADDRESS?: string;
  /** Optional JSON-RPC endpoint; defaults to the network's public one. */
  readonly BASE_RPC_URL?: string;
  readonly PAYMENTS?: string;
  /** Test injection for the chain reader; never set from configuration. */
  readonly CHAIN_RPC?: RpcCall;
}

export type DepositConfig =
  | { readonly mode: "off" }
  | {
      readonly mode: "on";
      readonly network: NetworkConfig;
      readonly address: string;
      readonly rpcUrl: string;
    }
  | { readonly mode: "invalid" };

/** On only for an enabled network, with sandbox payments and a valid platform address. */
export function depositConfigOf(env: ChainEnv): DepositConfig {
  const value = env.DEPOSITS;
  if (value === undefined || value === "" || value === "off") return { mode: "off" };
  const network = value === "base-sepolia" || value === "base" ? NETWORKS[value] : undefined;
  const address =
    typeof env.DEPOSIT_ADDRESS === "string" && /^0x[0-9a-fA-F]{40}$/.test(env.DEPOSIT_ADDRESS)
      ? env.DEPOSIT_ADDRESS.toLowerCase()
      : null;
  const rpcUrl = env.BASE_RPC_URL ?? network?.defaultRpcUrl;
  if (
    !network?.enabled ||
    resolvePaymentsMode(env.PAYMENTS) !== "sandbox" ||
    address === null ||
    address === `0x${"0".repeat(40)}` ||
    typeof rpcUrl !== "string" ||
    !rpcUrl.startsWith("https://")
  ) {
    return { mode: "invalid" };
  }
  return { mode: "on", network, address, rpcUrl };
}
