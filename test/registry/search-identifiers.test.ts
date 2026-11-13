import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { ContributionSearch } from "../../src/registry/search";
import {
  buildSearchText,
  identifierSearchText,
  splitIdentifier,
} from "../../src/registry/search-document";
import type { KnowledgeContributionInput } from "../../src/registry/knowledge";

describe("splitIdentifier", () => {
  it.each([
    ["successStatus", ["success", "Status"]],
    ["responseFields", ["response", "Fields"]],
    ["ResponseFields", ["Response", "Fields"]],
    ["HTTPStatus", ["HTTP", "Status"]],
    ["parseXMLFile", ["parse", "XML", "File"]],
    ["statusCode", ["status", "Code"]],
    ["http2Status", ["http", "2", "Status"]],
    ["rateLimit429", ["rate", "Limit", "429"]],
    ["snake_case-key.name", ["snake", "case", "key", "name"]],
    ["status", ["status"]],
    ["URL", ["URL"]],
    ["", []],
  ])("%s", (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });

  it("is deterministic and keeps the original identifier first", () => {
    expect(identifierSearchText("successStatus")).toBe("successStatus success Status");
    expect(identifierSearchText("successStatus")).toBe(identifierSearchText("successStatus"));
    expect(identifierSearchText("status")).toBe("status");
  });
});

describe("buildSearchText identifier terms", () => {
  const base = {
    family: "knowledge",
    title: "T",
    purpose: "P",
    contentType: "api-reference",
    summary: "S",
    explanation: "someExplanationWord",
    facts: [{ subject: "svc", predicate: "successStatus", value: "okValue" }],
    records: [{ responseFields: "x" }],
  } as unknown as KnowledgeContributionInput;

  it("adds components for fact predicates and record keys only", () => {
    const text = buildSearchText(base);
    expect(text).toContain("successStatus success Status");
    expect(text).toContain("responseFields response Fields");
    expect(text).toContain("okValue"); // values unchanged
    expect(text).not.toContain("some Explanation");
    expect(text).not.toContain("someExplanationWord");
  });

  it("does not split other fields such as title or scalar values", () => {
    const text = buildSearchText({
      ...base,
      title: "camelTitle",
      facts: [{ subject: "camelSubject", predicate: "p", value: "camelValue" }],
    } as unknown as KnowledgeContributionInput);
    expect(text).not.toContain("camel Title");
    expect(text).not.toContain("camel Subject");
    expect(text).not.toContain("camel Value");
  });
});

describe("indexed identifier search", () => {
  let proxy: PlatformProxy<RegistryEnv>;
  let dir: string;
  let search: ContributionSearch;
  let id = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "registry-search-ident-"));
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
    const registry = new ContributionRegistry(proxy.env, {
      now: () => new Date("2026-11-11T12:00:00Z"),
    });
    const identity = new IdentityRepository(db);
    const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(op.id)
      .run();
    const agent = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;
    const r = await registry.createContribution(agent, {
      family: "knowledge",
      title: "Quokka gateway reply",
      purpose: "Describe the reply",
      contentType: "api-reference",
      summary: "Reply contract.",
      facts: [{ subject: "quokka", predicate: "successStatus", value: 200 }],
      records: [{ responseFields: "id" }],
      evidence: [{ kind: "documentation", uri: "https://example.com/docs" }],
      licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
      reviewIntervalDays: 30,
      asOf: "2026-11-10T10:00:00Z",
      sources: [
        {
          uri: "https://example.com/src",
          accessedAt: "2026-11-10T10:00:00Z",
          hash: { algorithm: "sha256", digest: "b".repeat(64) },
        },
      ],
      rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
      verification: { method: "owner-tested", declaredConfidence: 0.9 },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    id = r.contribution.id;
    search = new ContributionSearch(proxy.env, { now: () => new Date("2026-11-12T00:00:00Z") });
  }, 120_000);
  afterAll(async () => {
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = async (query: string) => {
    const r = await search.search({ query });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.results.map((x) => x.id);
  };

  it.each([
    "successStatus",
    "success",
    "status",
    "success status",
    "responseFields",
    "response",
    "fields",
    "response fields",
  ])("finds the contribution by %s", async (q) => {
    expect(await ids(q)).toEqual([id]);
  });

  it("does not match unrelated words", async () => {
    expect(await ids("succ")).toEqual([]);
    expect(await ids("respon")).toEqual([]);
  });
});
