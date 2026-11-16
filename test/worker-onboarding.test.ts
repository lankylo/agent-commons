import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ONBOARDING_ALIAS_PATH, ONBOARDING_PATH } from "../src/onboarding/document";

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
