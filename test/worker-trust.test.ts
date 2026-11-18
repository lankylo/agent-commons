import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { ContributionRegistry } from "../src/registry/creation";
import { QualityReviewer } from "../src/registry/quality-review";
import { selectLines, sourceFetchTarget, sourceFetchUrl } from "../src/registry/source-check";
import { TrustStore, trustKey } from "../src/registry/trust";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

// Test-only placeholder, not a real credential.
const REVIEW_TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-15T00:00:00.000Z");
const DAY = 86_400_000;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly token: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let registry: ContributionRegistry;
let owner: Actor;
let ownerSibling: Actor;
let opA: Actor;
let opASibling: Actor;
let opB: Actor;
let opC: Actor;
let opD: Actor;
let counter = 0;

/** Bodies served by the stand-in fetcher, keyed by the URL actually requested. */
const pages = new Map<string, { status: number; body: string }>();
const fetched: string[] = [];
const fetcher = async (url: string): Promise<Response> => {
  fetched.push(url);
  const page = pages.get(url);
  if (!page) return new Response("missing", { status: 404 });
  return new Response(page.body, { status: page.status });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-trust-"));
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
  identity = new IdentityRepository(db);
  credentials = new CredentialService(db, { now: () => new Date(START) });
  owner = await createOperatorActor("Trust Owner", true);
  ownerSibling = await createAgent(owner.operatorId, "Trust Owner Sibling");
  opA = await createOperatorActor("Trust Operator A");
  opASibling = await createAgent(opA.operatorId, "Trust Operator A Sibling");
  opB = await createOperatorActor("Trust Operator B");
  opC = await createOperatorActor("Trust Operator C");
  opD = await createOperatorActor("Trust Operator D");
  registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function createOperatorActor(name: string, allowListed = false): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  return createAgent(operator.id, name);
}

async function createAgent(operatorId: OperatorId, name: string): Promise<Actor> {
  const agent = await identity.registerAgent(operatorId, {
    displayName: `${name} Agent ${++counter}`,
  });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, operatorId, token: issued.token };
}

function env(atMs: number) {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    RATE_LIMIT_AGENT_LIMIT: 100000,
    RATE_LIMIT_OPERATOR_LIMIT: 100000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => new Date(atMs),
    REVIEW_INTERFACE: "on",
    REVIEWER_ID: "trust-reviewer",
    REVIEWER_TOKEN: REVIEW_TOKEN,
    SOURCE_FETCHER: fetcher,
  };
}

async function post(path: string, body: unknown, token: string, atMs = START) {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(atMs) as never,
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Json };
}

const exact = (id: string) => ({ contributionId: id, version: 1, maxUtf8Bytes: 64000 });
const get = (id: string, actor: Actor) => post("/v1/commons/get", exact(id), actor.token);
const search = (query: string, actor: Actor) =>
  post("/v1/commons/search", { query, maxUtf8Bytes: 64000 }, actor.token);
const feedback = (id: string, assessment: Json, actor: Actor) =>
  post("/v1/commons/feedback", { contributionId: id, version: 1, assessment }, actor.token);
const review = (op: string, body: unknown, atMs = START) =>
  post(`/v1/review/${op}`, body, REVIEW_TOKEN, atMs);

/** Runs re-check batches until nothing is due at the given time. */
async function recheckAll(atMs: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const run = await review("recheck", {}, atMs);
    expect(run.status).toBe(200);
    if (run.body.remainingDue === 0) return;
  }
  throw new Error("source re-checks did not finish");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createKnowledge(word: string, source?: { uri: string; body: string }) {
  const sources = source
    ? [
        {
          uri: source.uri,
          accessedAt: "2026-11-11T11:00:00Z",
          hash: { algorithm: "sha256" as const, digest: await sha256(source.body) },
        },
      ]
    : HTTPBIN_KNOWLEDGE_SEED.sources;
  const result = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: `${word} knowledge ${++counter}`,
    sources,
  });
  if (!result.ok) throw new Error(`knowledge fixture failed: ${result.error.code}`);
  await listVersion(proxy.env, result.contribution.id);
  return result.contribution.id;
}

async function createExecution(word: string, related?: unknown[]) {
  const result = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_EXECUTION_SEED,
    title: `${word} execution ${++counter}`,
    ...(related ? { related } : {}),
  } as never);
  if (!result.ok) throw new Error(`execution fixture failed: ${result.error.code}`);
  await listVersion(proxy.env, result.contribution.id);
  return result.contribution.id;
}

const accuracy = (finding: string) => ({
  accuracy: {
    finding,
    scope: "The documented response fields",
    evidence: [{ kind: "documentation", uri: "https://docs.acme-widgets.io/reference" }],
  },
});

const outcome = (finding: "success" | "failure") => ({
  outcome: {
    finding,
    observedAt: "2026-11-15T00:00:00Z",
    steps: [
      { stepId: "fetch", result: finding === "success" ? "passed" : "failed", httpStatus: 200 },
      { stepId: "extract", result: "passed" },
      { stepId: "check_echo", result: "passed" },
    ],
  },
});

/** Retrieves (to earn the receipt) and then reports. */
async function report(id: string, assessment: Json, actor: Actor) {
  expect((await get(id, actor)).status).toBe(200);
  return feedback(id, assessment, actor);
}

async function trustOf(id: string, atMs = START) {
  const map = await new TrustStore(db, () => new Date(atMs)).read([{ id, version: 1 }]);
  const trust = map.get(trustKey(id, 1));
  if (!trust) throw new Error("trust not found");
  return trust;
}

interface StateRow {
  last_verified_at: string | null;
  reliability_score: number | null;
  consumer_count: number;
}
const STATE_SQL = `SELECT last_verified_at, reliability_score, consumer_count
  FROM version_platform_state WHERE contribution_id = ? AND version = 1`;
const platformState = (id: string) => db.prepare(STATE_SQL).bind(id).first<StateRow>();

describe("source fetch URL", () => {
  it("fetches a pinned GitHub blob as its raw file and refuses unsafe URIs", () => {
    expect(sourceFetchUrl(`https://github.com/acme/widgets/blob/${COMMIT}/docs/api.md`)).toBe(
      `https://raw.githubusercontent.com/acme/widgets/${COMMIT}/docs/api.md`,
    );
    expect(sourceFetchUrl("https://docs.acme-widgets.io/page#section")).toBe(
      "https://docs.acme-widgets.io/page",
    );
    expect(sourceFetchUrl("http://docs.acme-widgets.io/page")).toBeNull();
    expect(sourceFetchUrl("https://user:secret@docs.acme-widgets.io/page")).toBeNull();
    expect(sourceFetchUrl("not a url")).toBeNull();
  });

  it("hashes only the anchored lines of a GitHub blob, as sed prints them", () => {
    const blob = `https://github.com/acme/widgets/blob/${COMMIT}/src/app.py`;
    const raw = `https://raw.githubusercontent.com/acme/widgets/${COMMIT}/src/app.py`;
    expect(sourceFetchTarget(`${blob}#L3-L5`)).toEqual({ url: raw, lines: [3, 5] });
    expect(sourceFetchTarget(`${blob}#L7`)).toEqual({ url: raw, lines: [7, 7] });
    expect(sourceFetchTarget(blob)).toEqual({ url: raw, lines: null });
    // A malformed or reversed anchor hashes the whole file; other hosts ignore anchors.
    expect(sourceFetchTarget(`${blob}#L5-L3`)?.lines).toBeNull();
    expect(sourceFetchTarget(`${blob}#section`)?.lines).toBeNull();
    expect(sourceFetchTarget("https://docs.acme-widgets.io/page#L3-L5")?.lines).toBeNull();

    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const body = new TextEncoder().encode("one\ntwo\r\nthree\nfour");
    expect(text(selectLines(body, 2, 3))).toBe("two\r\nthree\n");
    expect(text(selectLines(body, 4, 4))).toBe("four\n");
    expect(text(selectLines(body, 3, 9))).toBe("three\nfour\n");
    expect(text(selectLines(body, 9, 9))).toBe("");
    expect(text(selectLines(new TextEncoder().encode("a\nb\n"), 1, 5))).toBe("a\nb\n");
  });
});

describe("unverified by default", () => {
  it("never presents a listed version as verified before a platform check passes", async () => {
    const id = await createKnowledge("defaultword");
    const got = await get(id, opA);
    expect(got.status).toBe(200);
    expect(got.body.quality).toMatchObject({
      state: "listed_unverified",
      independentlyVerified: false,
    });
    expect(got.body.trust).toMatchObject({
      verified: false,
      checks: [],
      sourceStatus: "unchecked",
    });
    expect(got.text).not.toMatch(/"verified":\s*true/);

    const found = await search("defaultword", opA);
    expect(found.body.quality.state).toBe("listed_unverified");
    expect(found.body.trust).toEqual([
      { contributionId: id, version: 1, verified: false, checks: [], flags: [] },
    ]);
  });

  it("ignores trust fields supplied by a contributor", async () => {
    const result = await registry.createContribution(owner.agentId, {
      ...HTTPBIN_KNOWLEDGE_SEED,
      title: `selfcertified knowledge ${++counter}`,
      verified: true,
      trust: { verified: true, checks: ["source_hash_match"] },
    } as never);
    if (result.ok) {
      await listVersion(proxy.env, result.contribution.id);
      expect((await trustOf(result.contribution.id)).verified).toBe(false);
    } else {
      expect(result.ok).toBe(false);
    }
  });
});

describe("source re-checks", () => {
  it("verifies a matching source, then flags it when the source changes", async () => {
    const uri = `https://github.com/acme/widgets/blob/${COMMIT}/docs/limits.md`;
    const raw = `https://raw.githubusercontent.com/acme/widgets/${COMMIT}/docs/limits.md`;
    pages.set(raw, { status: 200, body: "rate limit is 60 per hour" });
    const id = await createKnowledge("matchword", { uri, body: "rate limit is 60 per hour" });

    await recheckAll(START);
    expect(fetched).toContain(raw);
    expect(fetched).not.toContain(uri);
    const verified = await trustOf(id);
    expect(verified).toMatchObject({
      verified: true,
      checks: ["source_hash_match"],
      flags: [],
      sourceStatus: "matched",
    });
    expect((await platformState(id))?.last_verified_at).toBe(new Date(START).toISOString());

    const got = await get(id, opA);
    expect(got.body.quality).toMatchObject({
      state: "listed_verified",
      independentlyVerified: true,
    });
    expect(got.body.trust.checks).toEqual(["source_hash_match"]);
    const found = await search("matchword", opA);
    expect(found.body.quality.state).toBe("listed");
    expect(found.body.trust[0]).toMatchObject({ contributionId: id, verified: true });

    // Checked again only once it is due: nothing is fetched inside the interval.
    const before = fetched.length;
    const early = await review("recheck", {}, START + DAY);
    expect(early.body).toMatchObject({ checked: 0, remainingDue: 0 });
    expect(fetched.length).toBe(before);

    pages.set(raw, { status: 200, body: "rate limit is 30 per hour" });
    await recheckAll(START + 8 * DAY);
    const changed = await trustOf(id);
    expect(changed.verified).toBe(false);
    expect(changed.checks).toEqual([]);
    expect(changed.flags).toContain("source_changed");
    expect(changed.sourceStatus).toBe("changed");
    // The last time it did match is kept.
    expect((await platformState(id))?.last_verified_at).toBe(new Date(START).toISOString());
    expect((await get(id, opA)).body.quality.state).toBe("listed_unverified");
  });

  it("separates an unreachable source from a hash that was never reproduced", async () => {
    const gone = await createKnowledge("goneword", {
      uri: "https://docs.acme-widgets.io/gone",
      body: "original text",
    });
    const drift = "https://docs.acme-widgets.io/drift";
    pages.set(drift, { status: 200, body: "page text plus a changing banner" });
    const unconfirmed = await createKnowledge("driftword", { uri: drift, body: "page text" });
    const redirect = "https://docs.acme-widgets.io/moved";
    pages.set(redirect, { status: 301, body: "" });
    const moved = await createKnowledge("movedword", { uri: redirect, body: "moved text" });

    await recheckAll(START + 20 * DAY);
    expect(await trustOf(gone)).toMatchObject({ verified: false, sourceStatus: "unreachable" });
    expect((await trustOf(gone)).flags).toContain("source_unreachable");
    expect(await trustOf(unconfirmed)).toMatchObject({
      verified: false,
      sourceStatus: "unconfirmed",
    });
    expect((await trustOf(unconfirmed)).flags).toContain("source_hash_unconfirmed");
    expect((await trustOf(unconfirmed)).flags).not.toContain("source_changed");
    expect((await trustOf(moved)).sourceStatus).toBe("unreachable");
    expect((await platformState(gone))?.last_verified_at).toBeNull();

    const inspected = await review("inspect", { contributionId: unconfirmed, version: 1 });
    expect(inspected.status).toBe(200);
    expect(inspected.body.provenance).toMatchObject({
      contributorOperatorId: owner.operatorId,
      authorAgentId: owner.agentId,
      previousVersion: null,
    });
    expect(inspected.body.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inspected.body.trust.sourceStatus).toBe("unconfirmed");
    expect(inspected.body.sourceChecks).toHaveLength(1);
    expect(inspected.body.sourceChecks[0]).toMatchObject({
      uri: drift,
      outcome: "mismatch",
      httpStatus: 200,
      recordedDigest: await sha256("page text"),
      observedDigest: await sha256("page text plus a changing banner"),
    });
  });

  it("runs a bounded batch from the cron entry point and validates the manual command", async () => {
    const uri = "https://docs.acme-widgets.io/cron";
    pages.set(uri, { status: 200, body: "cron text" });
    const id = await createKnowledge("cronword", { uri, body: "cron text" });
    await worker.scheduled({}, env(START + 40 * DAY) as never);
    expect((await trustOf(id)).sourceStatus).toBe("matched");

    expect((await review("recheck", { limit: 0 })).status).toBe(400);
    expect((await review("recheck", { limit: 16 })).status).toBe(400);
    expect((await review("recheck", { extra: true })).status).toBe(400);
    const none = await post("/v1/review/recheck", {}, opA.token);
    expect(none.status).toBe(401);
  });

  it("verifies a line-anchored GitHub source and re-checks one version on demand", async () => {
    const raw = `https://raw.githubusercontent.com/acme/widgets/${COMMIT}/src/view.py`;
    const file = "import x\n\ndef view():\n    return x\n\n# end\n";
    pages.set(raw, { status: 200, body: file });
    const id = await createKnowledge("anchorword", {
      uri: `https://github.com/acme/widgets/blob/${COMMIT}/src/view.py#L3-L4`,
      body: "def view():\n    return x\n",
    });
    const at = START + 80 * DAY;
    await recheckAll(at);
    expect(await trustOf(id, at)).toMatchObject({ verified: true, sourceStatus: "matched" });

    // Not due again for 7 days, but a targeted re-check runs now and only for that version.
    pages.set(raw, { status: 200, body: file.replace("return x", "return y") });
    const targeted = await review("recheck", { contributionId: id, version: 1 }, at + DAY);
    expect(targeted.status).toBe(200);
    expect(targeted.body).toMatchObject({ checked: 1, mismatch: 1 });
    expect((await trustOf(id, at + DAY)).flags).toContain("source_changed");

    expect((await review("recheck", { contributionId: id })).status).toBe(400);
    expect((await review("recheck", { version: 1 })).status).toBe(400);
    const unknown = await review("recheck", { contributionId: "unknown-id", version: 1 });
    expect(unknown.body).toMatchObject({ checked: 0 });
  });

  it("keeps the check log append-only", async () => {
    const update = db.prepare("UPDATE source_checks SET outcome = 'match'");
    await expect(update.run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM source_checks").run()).rejects.toThrow();
  });
});

describe("independent operator agreement", () => {
  it("counts one vote per operator and needs two operators to verify Knowledge", async () => {
    const id = await createKnowledge("agreeword");

    expect((await report(id, accuracy("accurate"), opA)).status).toBe(200);
    // A second agent of the same operator cannot add a second vote.
    expect((await report(id, accuracy("accurate"), opASibling)).status).toBe(409);
    let trust = await trustOf(id);
    expect(trust).toMatchObject({ verified: false, confirmingOperators: 1 });
    expect(trust.checks).not.toContain("independent_operator_agreement");
    let state = await platformState(id);
    expect(state?.reliability_score).toBeNull();
    expect(state?.consumer_count).toBe(1);

    expect((await report(id, accuracy("accurate"), opB)).status).toBe(200);
    trust = await trustOf(id);
    expect(trust.verified).toBe(true);
    expect(trust.checks).toContain("independent_operator_agreement");
    state = await platformState(id);
    expect(state?.reliability_score).toBe(1);
    expect(state?.consumer_count).toBe(2);
    expect((await get(id, opC)).body.quality.state).toBe("listed_verified");

    // One dissenting operator lowers the score but is not yet a dispute.
    expect((await report(id, accuracy("inaccurate"), opC)).status).toBe(200);
    trust = await trustOf(id);
    expect(trust).toMatchObject({ verified: true, disputingOperators: 1 });
    expect(trust.flags).not.toContain("disputed");
    expect((await platformState(id))?.reliability_score).toBeCloseTo(0.6667, 4);

    // Two independent operators disputing it removes verification.
    expect((await report(id, accuracy("inaccurate"), opD)).status).toBe(200);
    trust = await trustOf(id);
    expect(trust.verified).toBe(false);
    expect(trust.flags).toContain("disputed");
    expect((await platformState(id))?.reliability_score).toBe(0.5);
    expect((await get(id, opA)).body.quality.state).toBe("listed_unverified");
  });

  it("gives the contributor's own operator no effect, even past the API checks", async () => {
    const id = await createKnowledge("selfword");
    // The API refuses the contributor's operator, whichever of its agents asks.
    expect((await report(id, accuracy("accurate"), owner)).status).toBe(403);
    expect((await report(id, accuracy("accurate"), ownerSibling)).status).toBe(403);

    // Even rows written around the API are ignored by the aggregation.
    await db
      .prepare(
        `INSERT INTO feedback_reports
           (consumer_operator_id, agent_id, contribution_id, version, dimension, assessment_json)
         VALUES (?, ?, ?, 1, 'accuracy', ?)`,
      )
      .bind(owner.operatorId, owner.agentId, id, JSON.stringify(accuracy("accurate").accuracy))
      .run();
    expect((await report(id, accuracy("accurate"), opA)).status).toBe(200);
    const trust = await trustOf(id);
    expect(trust).toMatchObject({ verified: false, confirmingOperators: 1 });
    const state = await platformState(id);
    expect(state?.reliability_score).toBeNull();
    // The owner's own retrievals are not independent consumers.
    expect(state?.consumer_count).toBe(1);
  });

  it("verifies Execution from platform validation plus one independent report, never by fetching", async () => {
    const id = await createExecution("execword");
    const before = fetched.length;
    expect((await report(id, outcome("success"), opA)).status).toBe(200);
    expect(await trustOf(id)).toMatchObject({
      verified: false,
      checks: ["independent_operator_agreement"],
    });
    const validated = await review("validate", { contributionId: id, version: 1, note: "Ran it" });
    expect(validated.status).toBe(200);
    expect(validated.body.schemaVersion).toBe("platform-validation/v1");
    const trust = await trustOf(id);
    expect(trust).toMatchObject({
      verified: true,
      checks: ["platform_validated", "independent_operator_agreement"],
      sourceStatus: "none",
    });

    // Either order works: validated first, then one independent report.
    const second = await createExecution("execword");
    await review("validate", { contributionId: second, version: 1, note: "Checked first" });
    expect((await trustOf(second)).verified).toBe(false);
    expect((await report(second, outcome("success"), opB)).status).toBe(200);
    expect((await trustOf(second)).verified).toBe(true);

    // Withdrawing the validation removes verification; only Execution can be validated.
    await review("validate", {
      contributionId: second,
      version: 1,
      note: "Found a problem",
      action: "withdraw",
    });
    expect((await trustOf(second)).verified).toBe(false);
    const knowledge = await createKnowledge("validword");
    const refused = await review("validate", { contributionId: knowledge, version: 1, note: "x" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("execution_only");
    expect((await review("validate", { contributionId: id, version: 1 })).status).toBe(400);
    await recheckAll(START + 60 * DAY);
    expect(fetched.slice(before).some((url) => url.includes("httpbin.org/get"))).toBe(false);
    expect((await trustOf(id)).sourceStatus).toBe("none");
  });

  it("flags a version that two independent operators report stale", async () => {
    const id = await createKnowledge("staleword");
    const stale = {
      staleness: {
        finding: "appears_stale",
        observedAt: "2026-11-15T00:00:00Z",
        evidence: [{ kind: "documentation", uri: "https://docs.acme-widgets.io/changelog" }],
      },
    };
    expect((await report(id, stale, opA)).status).toBe(200);
    expect((await trustOf(id)).flags).not.toContain("reported_stale");
    expect((await report(id, stale, opB)).status).toBe(200);
    expect((await trustOf(id)).flags).toContain("reported_stale");
  });
});

describe("ranking and dependents", () => {
  it("ranks verified versions first and cautioned versions last", async () => {
    const ids = [
      await createKnowledge("rankword"),
      await createKnowledge("rankword"),
      await createKnowledge("rankword"),
    ].sort();
    const [cautioned, plain, verified] = ids as [string, string, string];

    for (const actor of [opA, opB]) {
      expect((await report(verified, accuracy("accurate"), actor)).status).toBe(200);
      expect((await report(cautioned, accuracy("inaccurate"), actor)).status).toBe(200);
    }
    const found = await search("rankword", opC);
    const order = (found.body.data.results as { contributionId: string }[]).map(
      (r) => r.contributionId,
    );
    expect(order).toEqual([verified, plain, cautioned]);
    const trust = found.body.trust as { contributionId: string; verified: boolean }[];
    expect(trust.map((t) => t.contributionId)).toEqual(order);
    expect(trust.map((t) => t.verified)).toEqual([true, false, false]);
    expect(found.body.trust[2].flags).toContain("disputed");
  });

  it("flags a version whose referenced version is withdrawn or overdue", async () => {
    const knowledge = await createKnowledge("depword");
    const execution = await createExecution("depword", [
      { family: "knowledge", id: knowledge, version: 1 },
    ]);
    expect((await trustOf(execution)).flags).toEqual([]);

    // The Knowledge record is due for review 90 days after its asOf date; the recipe after 30.
    const later = await trustOf(execution, START + 200 * DAY);
    expect(later.flags).toContain("review_overdue");
    expect(later.flags).toContain("dependency_stale");

    const withdrawn = await new QualityReviewer(proxy.env, "trust-reviewer").decide(
      knowledge,
      1,
      "withdrawn",
      "test withdrawal",
    );
    expect(withdrawn.ok).toBe(true);
    const after = await trustOf(execution);
    expect(after.flags).toContain("dependency_unavailable");
    expect(after.flags).not.toContain("dependency_stale");
  });
});
