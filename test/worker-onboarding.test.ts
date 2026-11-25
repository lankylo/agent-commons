import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { DISCOVERY_PATH, ONBOARDING_ALIAS_PATH, ONBOARDING_PATH } from "../src/onboarding/document";

const DOMAIN = "commons.example.org";
const ORIGIN = `https://${DOMAIN}`;
const ONBOARDING_URL = `${ORIGIN}${ONBOARDING_PATH}`;
// Test-only placeholder, not a real credential.
const REVIEWER_TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
// Truthy stand-in: unauthenticated requests are refused before any storage access.
const DB = {};

type Env = Record<string, unknown>;
const ENROLL: Env = {
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: `${ORIGIN}/`,
  ENROLLMENT_CHAIN_ID: "1",
};
const MCP: Env = { MCP_HTTP: "on", MCP_ALLOWED_HOSTNAMES: DOMAIN };

function fetchAt(path: string, env: Env, init?: RequestInit, host = DOMAIN) {
  return worker.fetch(new Request(`https://${host}${path}`, init), env as never);
}

function post(path: string, env: Env, headers: Record<string, string> = {}) {
  return fetchAt(path, env, { method: "POST", headers, body: "{}" });
}

type ErrorBody = { error: { code: string; details?: { onboarding?: string } } };
type Discovery = {
  schemaVersion: string;
  onboarding: string;
  health: string;
  enrollment: { chainId: number };
  mcp: { url: string; tools: string[] } | null;
  payments: { mode: string | null; pricesMinor: { knowledge: number } };
};

describe("agent onboarding document", () => {
  it("is unavailable while enrollment is off and fails closed when misconfigured", async () => {
    const misconfigured = { ...ENROLL, ENROLLMENT_URI: "https://other.example/" };
    for (const path of [ONBOARDING_PATH, ONBOARDING_ALIAS_PATH]) {
      expect((await fetchAt(path, {})).status).toBe(404);
      expect((await fetchAt(path, { ...ENROLL, ENROLLMENT: "off" })).status).toBe(404);
      expect((await fetchAt(path, misconfigured)).status).toBe(503);
      expect((await fetchAt(path, ENROLL, { method: "POST" })).status).toBe(404);
    }
  });

  it("serves markdown built from the configured origin, never the request host", async () => {
    for (const path of [ONBOARDING_PATH, ONBOARDING_ALIAS_PATH]) {
      const res = await fetchAt(path, ENROLL, undefined, "attacker.example");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      const text = await res.text();
      expect(text).toContain(`${ORIGIN}/v1/enroll/challenge`);
      expect(text).toContain(`${ORIGIN}/v1/enroll/complete`);
      expect(text).toContain(`${ORIGIN}/pilot/enroll`);
      expect(text).toContain("Chain ID 1");
      expect(text).toContain("listed_unverified");
      expect(text).not.toContain("attacker.example");
    }
  });

  it("describes MCP and needs intake only when they are enabled", async () => {
    const basic = await (await fetchAt(ONBOARDING_PATH, ENROLL)).text();
    expect(basic).not.toContain(`${ORIGIN}/mcp`);
    expect(basic).not.toContain("/v1/commons/needs");
    const enabled = { ...ENROLL, ...MCP, NEEDS_INTAKE: "on" };
    const full = await (await fetchAt(ONBOARDING_PATH, enabled)).text();
    expect(full).toContain(`${ORIGIN}/mcp`);
    expect(full).toContain(`${ORIGIN}/v1/commons/needs`);
  });

  it("gives ready-to-paste client config only when MCP is on", async () => {
    const basic = await (await fetchAt(ONBOARDING_PATH, ENROLL)).text();
    expect(basic).not.toContain("claude mcp add");
    const full = await (await fetchAt(ONBOARDING_PATH, { ...ENROLL, ...MCP })).text();
    expect(full).toContain(`claude mcp add --transport http agent-commons ${ORIGIN}/mcp`);
    expect(full).toContain('bearer_token_env_var = "AGENT_COMMONS_CREDENTIAL"');
    expect(full).toContain('"Authorization": "Bearer ${AGENT_COMMONS_CREDENTIAL}"');
    expect(full).toContain("`commons.purchase`");
    expect(full).toContain(`${ORIGIN}${DISCOVERY_PATH}`);
    expect(full).toContain(`GET ${ORIGIN}/health`);
  });

  it("states prices that match the payments mode", async () => {
    const off = await (await fetchAt(ONBOARDING_PATH, ENROLL)).text();
    expect(off).toContain("Payments are off");
    expect(off).not.toContain("0.01 per Knowledge");
    expect(off).not.toContain("|purchase}");
    const live = await (await fetchAt(ONBOARDING_PATH, { ...ENROLL, PAYMENTS: "live" })).text();
    expect(live).toContain("0.01 per Knowledge version and 0.05 per verified Execution");
    expect(live).toContain("402");
    expect(live).toContain("|purchase}");
    expect(live).not.toContain("every price is 0");
    expect(live).not.toContain("free, operator-reviewed");
  });

  it("states earnings, settlement and the payout minimum while payments are on", async () => {
    const off = await (await fetchAt(ONBOARDING_PATH, ENROLL)).text();
    expect(off).not.toContain("Earnings:");
    expect(off).not.toContain("Payouts:");
    const live = await (await fetchAt(ONBOARDING_PATH, { ...ENROLL, PAYMENTS: "live" })).text();
    expect(live).toContain("earns 0.025 USDC");
    expect(live).toContain("contributors earn 50%");
    expect(live).toContain("There is no holding period");
    expect(live).not.toContain("Payouts:");
    const paying = await (
      await fetchAt(ONBOARDING_PATH, { ...ENROLL, PAYMENTS: "live", DEPOSITS: "base" })
    ).text();
    expect(paying).toContain("from 0.05 USDC");
    expect(paying).toContain(`POST ${ORIGIN}/v1/commons/payout`);
  });
});

describe("machine-readable discovery", () => {
  it("follows the onboarding availability rules", async () => {
    const misconfigured = { ...ENROLL, ENROLLMENT_URI: "https://other.example/" };
    expect((await fetchAt(DISCOVERY_PATH, {})).status).toBe(404);
    expect((await fetchAt(DISCOVERY_PATH, misconfigured)).status).toBe(503);
    expect((await fetchAt(DISCOVERY_PATH, ENROLL, { method: "POST" })).status).toBe(404);
  });

  it("builds endpoints from the configured origin and prices from the mode", async () => {
    const offRes = await fetchAt(DISCOVERY_PATH, ENROLL, undefined, "attacker.example");
    expect(offRes.status).toBe(200);
    expect(offRes.headers.get("Content-Type")).toContain("application/json");
    const offText = await offRes.text();
    expect(offText).not.toContain("attacker.example");
    const off = JSON.parse(offText) as Discovery;
    expect(off.schemaVersion).toBe("agent-commons-discovery/v1");
    expect(off.onboarding).toBe(ONBOARDING_URL);
    expect(off.health).toBe(`${ORIGIN}/health`);
    expect(off.enrollment.chainId).toBe(1);
    expect(off.mcp).toBeNull();
    expect(off.payments.mode).toBe("off");
    expect(off.payments.pricesMinor.knowledge).toBe(0);

    const liveEnv = { ...ENROLL, ...MCP, PAYMENTS: "live", DEPOSITS: "base" };
    const live = (await (await fetchAt(DISCOVERY_PATH, liveEnv)).json()) as Discovery;
    expect(live.mcp?.url).toBe(`${ORIGIN}/mcp`);
    expect(live.mcp?.tools).toContain("commons.purchase");
    expect(live.payments).toMatchObject({
      mode: "live",
      currency: "USDC",
      network: "base",
      pricesMinor: { knowledge: 10_000, verifiedExecution: 50_000, unverifiedExecution: 0 },
      verificationRewardMinor: 25_000,
      settlementHoldDays: 0,
      payoutMinimumMinor: 50_000,
    });
    expect(off.payments).toMatchObject({ settlementHoldDays: null, payoutMinimumMinor: null });
  });
});

describe("unauthenticated agent requests point to onboarding", () => {
  it("adds the pointer to REST and MCP 401s while enrollment is on", async () => {
    const env = { ...ENROLL, ...MCP, DB };
    const responses = [
      await post("/v1/commons/search", env),
      await post("/v1/commons/get", env, { Authorization: "Basic abc" }),
      await post("/mcp", env, { "Content-Type": "application/json" }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get("Link")).toBe(`<${ONBOARDING_URL}>; rel="help"`);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.details?.onboarding).toBe(ONBOARDING_URL);
    }
    expect(responses[2]!.headers.get("WWW-Authenticate")).toBe('Bearer realm="agent-commons"');
  });

  it("leaves 401s unchanged while enrollment is off and never alters review 401s", async () => {
    const off = await post("/v1/commons/search", { DB });
    expect(off.status).toBe(401);
    expect(off.headers.get("Link")).toBeNull();
    expect(((await off.json()) as ErrorBody).error.details).toBeUndefined();
    const reviewEnv = {
      ...ENROLL,
      REVIEW_INTERFACE: "on",
      REVIEWER_ID: "pilot-reviewer",
      REVIEWER_TOKEN,
    };
    const review = await post("/v1/review/queue", reviewEnv);
    expect(review.status).toBe(401);
    expect(review.headers.get("Link")).toBeNull();
  });
});
