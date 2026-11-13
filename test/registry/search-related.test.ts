import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { buildDiscoveryResponse } from "../../src/registry/discovery";
import { ContributionSearch, type SearchResultItem } from "../../src/registry/search";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let registry: ContributionRegistry;
let search: ContributionSearch;
let agent: AgentId;
const ids: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-search-related-"));
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
  const db = proxy.env.DB;
  registry = new ContributionRegistry(proxy.env);
  // Search gets D1 only; any R2 access fails the test.
  search = new ContributionSearch(
    {
      DB: db,
      get CONTENT_BUCKET(): never {
        throw new Error("search must not access R2");
      },
    } as { DB: D1Database },
    { now: () => new Date("2026-11-15T00:00:00.000Z") },
  );
  const identity = new IdentityRepository(db);
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  agent = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;

  // Knowledge targets (kA has v1+v2; kB v1), Execution target eT.
  ids.kA = await create(knowledge("Zebrafinch alpha"));
  ids.kB = await create(knowledge("Zebrafinch beta"));
  ids.eT = await create(execution("Pelican target", []));
  // Execution with two ordered refs (B then A) pinned to exact versions.
  ids.eMulti = await create(
    execution("Pelican multi", [
      { family: "knowledge", id: ids.kB!, version: 1 },
      { family: "knowledge", id: ids.kA!, version: 1 },
    ]),
  );
  // Execution with no references.
  ids.eNone = await create(execution("Pelican none", []));
  // Knowledge referencing an Execution.
  ids.kToE = await create(
    knowledge("Zebrafinch pointer", [{ family: "execution", id: ids.eT!, version: 1 }]),
  );
  // Version 2 of kA keeps a different single reference; v1 had none.
  const v2 = await registry.createContributionVersion(
    agent,
    ids.kA!,
    1,
    knowledge("Zebrafinch alpha revised", [{ family: "execution", id: ids.eT!, version: 1 }]),
  );
  if (!v2.ok) throw new Error(JSON.stringify(v2.error));
}, 180_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function create(input: Record<string, unknown>): Promise<string> {
  const r = await registry.createContribution(agent, input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.contribution.id;
}

const base = {
  evidence: [{ kind: "documentation", uri: "https://example.com/docs" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  asOf: "2026-11-10T10:00:00Z",
};
function knowledge(title: string, related: unknown[] = []): Record<string, unknown> {
  return {
    ...base,
    family: "knowledge",
    title,
    purpose: "Record documented quotas",
    contentType: "api-reference",
    summary: "Quotas for the quokka gateway.",
    facts: [{ subject: "quokka-gateway", predicate: "burstQuota", value: title }],
    sources: [
      {
        uri: "https://example.com/src",
        accessedAt: "2026-11-10T10:00:00Z",
        hash: { algorithm: "sha256", digest: "b".repeat(64) },
      },
    ],
    rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
    verification: { method: "owner-tested", declaredConfidence: 0.9 },
    ...(related.length > 0 ? { related } : {}),
  };
}
function execution(title: string, related: unknown[]): Record<string, unknown> {
  return {
    ...base,
    family: "execution",
    title,
    purpose: "Retrieve a record and confirm it",
    contentType: "api-recipe",
    objective: `Fetch the manifest ${title}`,
    inputs: [{ name: "pelicanId", type: "string", required: true }],
    outputs: [{ name: "status", type: "integer", variable: "itemStatus" }],
    targetDomains: ["pelican.example.net"],
    compatibility: { requiredCapabilities: ["http-client", "jsonpointer"] },
    steps: [
      {
        id: "fetch",
        type: "http_request",
        method: "GET",
        domain: "pelican.example.net",
        path: "/v1/items",
        query: { id: { input: "pelicanId" } },
        expectStatus: [200],
        saveAs: "itemBody",
      },
      {
        id: "pick",
        type: "extract_field",
        from: "itemBody",
        pointer: "/status",
        saveAs: "itemStatus",
      },
      {
        id: "check",
        type: "assert",
        source: { variable: "itemStatus" },
        operator: "equals",
        expected: 1,
      },
    ],
    successChecks: ["check"],
    safety: {
      sideEffect: "read-only",
      requiresHumanApproval: false,
      maxRequests: 1,
      timeoutSeconds: 30,
      onFailure: "stop",
    },
    verification: { method: "owner-tested", testedAt: "2026-11-10T10:00:00Z" },
    ...(related.length > 0 ? { related } : {}),
  };
}

async function run(query: string): Promise<readonly SearchResultItem[]> {
  const r = await search.search({ query });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.results;
}
const byId = (rs: readonly SearchResultItem[], id: string): SearchResultItem =>
  rs.find((r) => r.id === id)!;

describe("search results: related references", () => {
  it("lists Execution -> Knowledge references in stored order with exact versions", async () => {
    const m = byId(await run("pelican multi"), ids.eMulti!);
    expect(m.related).toEqual([
      { family: "knowledge", id: ids.kB, version: 1 },
      { family: "knowledge", id: ids.kA, version: 1 },
    ]);
  });

  it("lists Knowledge -> Execution references", async () => {
    const k = byId(await run("zebrafinch pointer"), ids.kToE!);
    expect(k.related).toEqual([{ family: "execution", id: ids.eT, version: 1 }]);
  });

  it("returns an empty frozen list when there are no references", async () => {
    const e = byId(await run("pelican none"), ids.eNone!);
    expect(e.related).toEqual([]);
    expect(Object.isFrozen(e.related)).toBe(true);
  });

  it("uses the references of the latest version only", async () => {
    const rs = await run("zebrafinch alpha");
    const a = byId(rs, ids.kA!);
    expect(a.version).toBe(2);
    expect(a.related).toEqual([{ family: "execution", id: ids.eT, version: 1 }]);
    expect(rs.filter((r) => r.id === ids.kA)).toHaveLength(1);
  });

  it("is deeply frozen", async () => {
    const m = byId(await run("pelican multi"), ids.eMulti!);
    expect(Object.isFrozen(m.related)).toBe(true);
    for (const r of m.related) expect(Object.isFrozen(r)).toBe(true);
    expect(Object.keys(m.related[0]!).sort()).toEqual(["family", "id", "version"]);
  });

  it("keeps the ranked contribution order and is stable across repeated calls", async () => {
    const first = await run("zebrafinch");
    const second = await run("zebrafinch");
    expect(first.length).toBeGreaterThan(1);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(second.map((r) => r.related)).toEqual(first.map((r) => r.related));
  });

  it("propagates through discovery-response/v1 with only the allow-listed shape", async () => {
    const rs = await run("pelican multi");
    const res = buildDiscoveryResponse(rs);
    const item = res.results.find((r) => r.contributionId === ids.eMulti)!;
    expect(item.related).toEqual([
      { family: "knowledge", id: ids.kB, version: 1 },
      { family: "knowledge", id: ids.kA, version: 1 },
    ]);
    expect(Object.isFrozen(item.related)).toBe(true);
    for (const r of item.related) expect(Object.isFrozen(r)).toBe(true);
    const json = JSON.stringify(res);
    expect(json).not.toContain("objective");
    expect(json).not.toContain("summary");
    expect(json).not.toContain("facts");
  });
});
