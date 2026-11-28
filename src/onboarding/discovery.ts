/**
 * Machine-readable discovery (`/agent-commons.json`): the same public facts as the onboarding
 * document, as JSON, so an agent can find the MCP endpoint, how to get a credential, health and
 * prices without parsing markdown.
 *
 * Same availability rule as onboarding: served only while wallet enrollment is enabled and valid,
 * and every URL is built from the configured `ENROLLMENT_URI` origin, never the request Host
 * header. It contains no secrets, identities or counts and grants no access.
 */
import { resolveEnrollmentConfig } from "../enrollment/routes";
import { MCP_PATH, resolveMcpHttpConfig } from "../mcp/http";
import { MIN_PAYOUT_MINOR } from "../payments/payouts";
import { PAID_PRICES, VERIFICATION_REWARD } from "../payments/pricing";
import { SETTLEMENT_HOLD_DAYS } from "../payments/settlement";
import { X402_GET_PATH, X402_VERSION, x402ConfigOf } from "../payments/x402";
import { resolvePaymentsMode } from "../payments/provider";
import {
  DISCOVERY_PATH,
  HEALTH_PATH,
  MCP_TOOLS,
  ONBOARDING_ALIAS_PATH,
  ONBOARDING_PATH,
  type OnboardingEnv,
} from "./document";

export const REGISTRY_NAME = "io.github.lankylo/agent-commons";

export function renderDiscovery(origin: string, chainId: number, env: OnboardingEnv) {
  const mcpOn = resolveMcpHttpConfig(env).state === "on";
  const payments = resolvePaymentsMode(env.PAYMENTS) ?? null;
  const paid = payments === "sandbox" || payments === "live";
  const network = env.DEPOSITS === "base" || env.DEPOSITS === "base-sepolia" ? env.DEPOSITS : null;
  const x402On = x402ConfigOf(env).mode === "on";
  return {
    schemaVersion: "agent-commons-discovery/v1",
    name: "Agent Commons",
    description:
      "Operator-reviewed registry of reusable API Knowledge records and declarative Execution " +
      "recipes for AI agents.",
    registryName: REGISTRY_NAME,
    onboarding: `${origin}${ONBOARDING_PATH}`,
    llmsTxt: `${origin}${ONBOARDING_ALIAS_PATH}`,
    health: `${origin}${HEALTH_PATH}`,
    enrollment: {
      browser: `${origin}/pilot/enroll`,
      challenge: `${origin}/v1/enroll/challenge`,
      complete: `${origin}/v1/enroll/complete`,
      rotate: `${origin}/v1/enroll/rotate`,
      signature: "EIP-191 personal_sign of an ERC-4361 message",
      chainId,
    },
    auth: { type: "bearer", header: "Authorization", format: "Bearer <credential>" },
    mcp: mcpOn
      ? { url: `${origin}${MCP_PATH}`, transport: "streamable-http", tools: [...MCP_TOOLS] }
      : null,
    rest: { baseUrl: `${origin}/v1/commons`, needsIntake: env.NEEDS_INTAKE === "on" },
    payments: {
      mode: payments,
      currency: "USDC",
      decimals: 6,
      network: paid ? network : null,
      pricesMinor: paid
        ? {
            knowledge: PAID_PRICES.knowledge.amountMinor,
            verifiedExecution: PAID_PRICES.execution.amountMinor,
            unverifiedExecution: 0,
          }
        : { knowledge: 0, verifiedExecution: 0, unverifiedExecution: 0 },
      verificationRewardMinor: paid ? VERIFICATION_REWARD.totalMinor : 0,
      settlementHoldDays: paid ? SETTLEMENT_HOLD_DAYS : null,
      payoutMinimumMinor: paid && network ? MIN_PAYOUT_MINOR : null,
      x402: x402On
        ? { url: `${origin}${X402_GET_PATH}`, version: X402_VERSION, scheme: "exact" }
        : null,
    },
  };
}

/** Serves the discovery JSON, or returns null for any other path. */
export function handleDiscovery(request: Request, env: OnboardingEnv): Response | null {
  const { pathname } = new URL(request.url);
  if (pathname !== DISCOVERY_PATH) return null;
  const config = resolveEnrollmentConfig(env);
  if (config === false || request.method !== "GET") {
    return new Response("Not Found", { status: 404 });
  }
  if (config === null) return new Response("Service Unavailable", { status: 503 });
  const origin = new URL(config.uri).origin;
  return Response.json(renderDiscovery(origin, config.chainId, env), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
