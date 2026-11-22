import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { ContributionRegistry } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import { BOARD_PATH, topicFor, type Board } from "../src/home/board";
import { HOME_CSS_PATH, HOME_JS_PATH } from "../src/home/page";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

const DOMAIN = "commons.example.org";
const ORIGIN = `https://${DOMAIN}`;
const ENROLL = {
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: `${ORIGIN}/`,
  ENROLLMENT_CHAIN_ID: "1",
};
const START = Date.parse("2026-11-22T06:00:00.000Z");

function fetchAt(path: string, env: Record<string, unknown>, init?: RequestInit, host = DOMAIN) {
  return worker.fetch(new Request(`https://${host}${path}`, init), env as never);
}

describe("homepage", () => {
  it("follows the onboarding availability rules", async () => {
    const misconfigured = { ...ENROLL, ENROLLMENT_URI: "https://other.example/" };
    for (const path of ["/", HOME_CSS_PATH, HOME_JS_PATH]) {
      expect((await fetchAt(path, {})).status).toBe(404);
      expect((await fetchAt(path, misconfigured)).status).toBe(503);
      expect((await fetchAt(path, ENROLL, { method: "POST" })).status).toBe(404);
    }
  });

  it("serves HTML built from the configured origin under a strict CSP", async () => {
    const res = await fetchAt("/", ENROLL, undefined, "attacker.example");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    // Only Cloudflare Web Analytics is allowed beside the page's own origin.
    expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com;");
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com;");
    const html = await res.text();
    expect(html).toContain(`claude mcp add --transport http agent-commons ${ORIGIN}/mcp`);
    expect(html).toContain('href="/pilot/enroll"');
    expect(html).toContain('href="/llms.txt"');
    expect(html).not.toContain("attacker.example");
    expect(html).not.toMatch(/<script>|style="/);
  });

  it("serves its stylesheet and script, and answers HEAD without a body", async () => {
    const css = await fetchAt(HOME_CSS_PATH, ENROLL);
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    const js = await fetchAt(HOME_JS_PATH, ENROLL);
    expect(js.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    const script = await js.text();
    expect(script).toContain(BOARD_PATH);
    expect(script).not.toContain("innerHTML");
    const head = await fetchAt("/", ENROLL, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("public board availability", () => {
  it("is off with enrollment, fails closed without storage and refuses other methods", async () => {
    expect((await fetchAt(BOARD_PATH, {})).status).toBe(404);
    expect((await fetchAt(BOARD_PATH, ENROLL)).status).toBe(503);
    expect((await fetchAt(BOARD_PATH, ENROLL, { method: "POST" })).status).toBe(404);
  });

  it("groups titles into map topics deterministically", () => {
    expect(topicFor("Node.js: EMFILE (too many open files)")).toBe("Node.js");
    expect(topicFor("SSH to GitHub: Host key verification failed")).toBe("Git & GitHub");
    expect(topicFor("pip: ResolutionImpossible, conflicting dependencies")).toBe("Python");
    expect(topicFor("httpbin GET /gzip decompression diagnostic")).toBe("HTTP diagnostics");
    expect(topicFor("ESLint v9: couldn't find an eslint.config.* file")).toBe("Dev tooling");
    expect(topicFor("Kubernetes CrashLoopBackOff: restart backoff timing")).toBe("Kubernetes");
    expect(topicFor("kubectl logs empty for a Docker image")).toBe("Kubernetes");
    expect(topicFor("Frankfurter latest USD to EUR rate lookup")).toBe("APIs & more");
  });
});

describe("public board feed", () => {
  let proxy: PlatformProxy<RegistryEnv>;
  let dir: string;
  let db: D1Database;
  let registry: ContributionRegistry;
  let agentId: AgentId;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "worker-home-"));
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        "wrangler.d1-local.jsonc",
        "--persist-to",
        dir,
      ],
      { stdio: "pipe" },
    );
    proxy = await getPlatformProxy<RegistryEnv>({
      configPath: "wrangler.registry-local.jsonc",
      persist: { path: join(dir, "v3") },
    });
    db = proxy.env.DB;
    const identity = new IdentityRepository(db);
    const operator = await identity.createOperator({ kind: "organization", displayName: "Home" });
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
    agentId = (await identity.registerAgent(operator.id, { displayName: "Home Agent" })).id;
    registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });

    const create = async (key: string, seed: object, title: string, list = true) => {
      const r = await registry.createContribution(agentId, { ...seed, title } as never);
      if (!r.ok) throw new Error(`fixture ${key} failed: ${r.error.code}`);
      ids[key] = r.contribution.id;
      if (list) await listVersion(proxy.env, r.contribution.id);
    };
    await create("knowledge", HTTPBIN_KNOWLEDGE_SEED, "Node.js: EMFILE fixture");
    await create("listedRecipe", HTTPBIN_EXECUTION_SEED, "httpbin plain recipe fixture");
    await create("awaiting", HTTPBIN_EXECUTION_SEED, "httpbin awaiting recipe fixture");
    await create("verified", HTTPBIN_EXECUTION_SEED, "httpbin verified recipe fixture");
    await create("pending", HTTPBIN_EXECUTION_SEED, "httpbin pending recipe fixture", false);

    const at = new Date(START).toISOString();
    for (const key of ["awaiting", "verified"]) {
      await db
        .prepare(
          "INSERT INTO platform_validations (contribution_id, version, action, note, set_by, created_at) VALUES (?, 1, 'validate', 'fixture', 'test', ?)",
        )
        .bind(ids[key], at)
        .run();
    }
    await db
      .prepare(
        "INSERT INTO version_trust (contribution_id, version, source_status, confirming_operators, reporting_operators, verified, updated_at) VALUES (?, 1, 'none', 1, 1, 1, ?) ON CONFLICT (contribution_id, version) DO UPDATE SET confirming_operators = 1, reporting_operators = 1, verified = 1",
      )
      .bind(ids.verified, at)
      .run();
  }, 180_000);

  afterAll(async () => {
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (atMs: number, payments = "live") => ({
    ...ENROLL,
    DB: db,
    PAYMENTS: payments,
    NOW: () => new Date(atMs),
  });

  async function board(atMs: number, payments?: string): Promise<Board> {
    const res = await fetchAt(BOARD_PATH, env(atMs, payments));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    return (await res.json()) as Board;
  }

  it("lists only listed versions, with status, prices and open rewards", async () => {
    const b = await board(START);
    expect(b.schemaVersion).toBe("public-board/v1");
    const byId = new Map(b.records.map((r) => [r.contributionId, r]));
    expect(byId.has(ids.pending!)).toBe(false);
    expect(byId.get(ids.knowledge!)).toMatchObject({
      family: "knowledge",
      topic: "Node.js",
      status: "listed",
      priceMinor: 10_000,
      rewardMinor: 0,
    });
    expect(byId.get(ids.listedRecipe!)).toMatchObject({ status: "listed", priceMinor: 0 });
    expect(byId.get(ids.awaiting!)).toMatchObject({
      status: "awaiting_validator",
      priceMinor: 0,
      rewardMinor: 25_000,
    });
    expect(byId.get(ids.verified!)).toMatchObject({ status: "verified", priceMinor: 50_000 });
    expect(b.counts).toMatchObject({
      listed: 4,
      knowledge: 1,
      execution: 3,
      verified: 1,
      openRewards: 1,
      openRewardsMinor: 25_000,
    });
    expect(Object.keys(b.counts)).not.toContain("enrolledOperators");
    const text = JSON.stringify(b);
    expect(text).not.toContain(agentId);
    expect(text).not.toContain("pending recipe fixture");
    expect(text).not.toContain('"steps"');
    const kinds = new Set(b.activity.map((a) => a.kind));
    expect(kinds.has("listed")).toBe(true);
    expect(kinds.has("platform_validated")).toBe(true);
  });

  it("shows zero prices and no rewards while payments are off", async () => {
    const b = await board(START + 3_600_000, "off");
    expect(b.payments.mode).toBe("off");
    expect(b.records.every((r) => r.priceMinor === 0 && r.rewardMinor === 0)).toBe(true);
    expect(b.counts.openRewards).toBe(1);
    expect(b.counts.openRewardsMinor).toBe(0);
  });
});
