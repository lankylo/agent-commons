import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId } from "../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../src/registry/creation";
import { QualityReviewer } from "../src/registry/quality-review";
import { contentObjectKey } from "../src/storage/content-objects";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let author: AgentId;
const tokens: Record<"author" | "sibling" | "other", string> = {
  author: "",
  sibling: "",
  other: "",
};
let n = 0;
const clock = new Date("2026-11-15T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-preview-"));
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
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
  const identity = new IdentityRepository(db);
  const creds = new CredentialService(db, { now: () => clock });
  const op = await identity.createOperator({ kind: "organization", displayName: "Prev Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const a = await identity.registerAgent(op.id, { displayName: "Author" });
  const s = await identity.registerAgent(op.id, { displayName: "Sibling" });
  const op2 = await identity.createOperator({ kind: "organization", displayName: "Other Op" });
  const o = await identity.registerAgent(op2.id, { displayName: "Other" });
  author = a.id;
  tokens.author = (await creds.issueCredential(a.id, { label: "a" })).token;
  tokens.sibling = (await creds.issueCredential(s.id, { label: "s" })).token;
  tokens.other = (await creds.issueCredential(o.id, { label: "o" })).token;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  path: "preview" | "get" | "search",
  body: Record<string, unknown>,
  who: keyof typeof tokens | null = "author",
  limits: Record<string, number> = {},
) {
  const headers = new Headers();
  if (who) headers.set("Authorization", `Bearer ${tokens[who]}`);
  const res = await worker.fetch(
    new Request(`https://example.com/v1/commons/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
      RATE_LIMIT_AGENT_LIMIT: 10000,
      RATE_LIMIT_OPERATOR_LIMIT: 10000,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      NOW: () => clock,
      ...limits,
    } as never,
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const preview = (
  id: string,
  version = 1,
  who: keyof typeof tokens | null = "author",
  extra: Record<string, unknown> = {},
) => call("preview", { contributionId: id, version, maxUtf8Bytes: 64000, ...extra }, who);

type Family = "knowledge" | "execution";
const seed = (f: Family) => (f === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED);
async function create(family: Family, word: string, related?: unknown[]) {
  const r = await registry.createContribution(author, {
    ...seed(family),
    title: `${word} ${family} ${++n}`,
    ...(related ? { related } : {}),
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.contribution;
}
async function newVersion(family: Family, id: string, prev: number, word: string) {
  const r = await registry.createContributionVersion(author, id, prev, {
    ...seed(family),
    title: `${word} ${family} ${++n}`,
  });
  if (!r.ok) throw new Error(r.error.code);
}
const count = async (table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>())?.c;
const state = async (id: string, v = 1) =>
  (
    await db
      .prepare("SELECT state FROM version_quality_states WHERE contribution_id=? AND version=?")
      .bind(id, v)
      .first<{ state: string }>()
  )?.state;

const FAMILIES: Family[] = ["knowledge", "execution"];

describe("contributor preview", () => {
  for (const family of FAMILIES) {
    it(`${family}: author previews own pending version, labelled, without receipt or listing`, async () => {
      const word = `previewalpha${family}`;
      const c = await create(family, word);
      const receipts = await count("retrieval_receipts");
      const r = await preview(c.id);
      expect(r.status).toBe(200);
      expect(r.body.data.family).toBe(family);
      expect(r.body.data.contributionId).toBe(c.id);
      expect(r.body.quality).toMatchObject({ state: "pending", preview: true });
      expect(r.body.quality.independentlyVerified).toBe(false);
      if (family === "knowledge") expect(r.body.data.untrustedExplanation).toBeDefined();
      // public allow-list: no author identity or storage keys
      for (const key of [
        "author",
        "contributor",
        "authorAgentId",
        "authorOperatorId",
        "contentKey",
      ]) {
        expect(r.text).not.toContain(`"${key}"`);
      }
      expect(r.body.budget.usedUtf8Bytes).toBeGreaterThan(0);
      expect(await count("retrieval_receipts")).toBe(receipts);
      expect(await state(c.id)).toBe("pending");
      const s = await call("search", { query: word, maxUtf8Bytes: 64000 });
      expect(s.body.data.results).toEqual([]);
      expect(
        (await call("get", { contributionId: c.id, version: 1, maxUtf8Bytes: 64000 })).status,
      ).toBe(404);
    });

    it(`${family}: new pending version previews while listed v1 stays public; v1 is not previewable once listed`, async () => {
      const c = await create(family, `previewbeta${family}`);
      await listVersion(proxy.env, c.id);
      await newVersion(family, c.id, 1, `previewbetatwo${family}`);
      expect((await preview(c.id, 2)).status).toBe(200);
      const v1 = await preview(c.id, 1);
      expect(v1.status).toBe(404);
      expect(await state(c.id, 2)).toBe("pending");
    });

    it(`${family}: other agent, other operator, missing and non-pending states share one 404`, async () => {
      const c = await create(family, `previewgamma${family}`);
      const rejected = await create(family, `previewrej${family}`);
      await new QualityReviewer(proxy.env, "rev").decide(rejected.id, 1, "rejected", "t");
      const withdrawn = await create(family, `previewwd${family}`);
      await listVersion(proxy.env, withdrawn.id);
      await new QualityReviewer(proxy.env, "rev").decide(withdrawn.id, 1, "withdrawn", "t");
      const listed = await create(family, `previewlisted${family}`);
      await listVersion(proxy.env, listed.id);
      const before = await count("retrieval_receipts");
      const all = [
        await preview(c.id, 1, "sibling"),
        await preview(c.id, 1, "other"),
        await preview(c.id, 2),
        await preview("00000000-0000-4000-8000-000000000000"),
        await preview(rejected.id),
        await preview(withdrawn.id),
        await preview(listed.id),
      ];
      for (const r of all) {
        expect(r.status).toBe(404);
        expect(r.text).toBe(all[0]?.text);
        expect(r.body.data).toBeUndefined();
      }
      expect(all[0]?.text).not.toContain(c.id);
      expect(await count("retrieval_receipts")).toBe(before);
    });

    it(`${family}: identity cannot be supplied; conditional and unsupported fields are rejected`, async () => {
      const c = await create(family, `previewdelta${family}`);
      for (const extra of [
        { agentId: author },
        { operatorId: "x" },
        { validator: { contributionId: c.id, version: 1, contentHash: "0".repeat(64) } },
        { family },
        { includeAuthor: true },
      ]) {
        const r = await preview(c.id, 1, "other", extra);
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe("invalid_request");
      }
      expect((await call("preview", { contributionId: c.id, version: 1 })).body.error.code).toBe(
        "invalid_budget",
      );
      expect(
        (await call("preview", { contributionId: c.id, version: 0, maxUtf8Bytes: 9 })).status,
      ).toBe(400);
    });

    it(`${family}: budget failure returns 413 with no content or receipt`, async () => {
      const c = await create(family, `previewbudget${family}`);
      const before = await count("retrieval_receipts");
      const r = await preview(c.id, 1, "author", { maxUtf8Bytes: 50 });
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe("response_too_large");
      expect(r.body.data).toBeUndefined();
      expect(r.text).not.toContain("untrustedExplanation");
      expect(await count("retrieval_receipts")).toBe(before);
    });

    it(`${family}: missing and corrupted content fail safely`, async () => {
      const missing = await create(family, `previewmissing${family}`);
      await proxy.env.CONTENT_BUCKET.delete(contentObjectKey(missing.contentHash));
      const m = await preview(missing.id);
      expect(m.status).toBe(500);
      expect(m.body.error.code).toBe("content_unavailable");

      const bad = await create(family, `previewbad${family}`);
      await proxy.env.CONTENT_BUCKET.put(
        contentObjectKey(bad.contentHash),
        new TextEncoder().encode('{"tampered":true}'),
      );
      const b = await preview(bad.id);
      expect(b.status).toBe(500);
      expect(b.body.error.code).toBe("content_unavailable");
      expect(b.text).not.toContain("tampered");
      // another agent still sees only the uniform 404, not the integrity failure
      expect((await preview(bad.id, 1, "sibling")).status).toBe(404);
    });
  }

  it("omits references to non-listed versions in a preview", async () => {
    const hidden = await create("knowledge", "previewrefhidden");
    const shown = await create("knowledge", "previewrefshown");
    await listVersion(proxy.env, shown.id);
    const c = await create("execution", "previewrefmain", [
      { family: "knowledge", id: hidden.id, version: 1 },
      { family: "knowledge", id: shown.id, version: 1 },
    ]);
    const r = await preview(c.id);
    expect(r.status).toBe(200);
    expect(r.body.data.related).toEqual([{ family: "knowledge", id: shown.id, version: 1 }]);
    expect(r.text).not.toContain(hidden.id);
  });

  it("requires a valid credential and shares the rate limit", async () => {
    const c = await create("knowledge", "previewauth");
    expect((await preview(c.id, 1, null)).status).toBe(401);
    const limited = { RATE_LIMIT_AGENT_LIMIT: 1, NOW: () => new Date(clock.getTime() + 600_000) };
    const first = await call(
      "preview",
      { contributionId: c.id, version: 1, maxUtf8Bytes: 64000 },
      "sibling",
      limited,
    );
    expect(first.status).toBe(404);
    // The same agent's get call is counted in the same budget window as preview.
    const second = await call(
      "get",
      { contributionId: c.id, version: 1, maxUtf8Bytes: 64000 },
      "sibling",
      limited,
    );
    expect(second.status).toBe(429);
    const third = await call(
      "preview",
      { contributionId: c.id, version: 1, maxUtf8Bytes: 64000 },
      "sibling",
      limited,
    );
    expect(third.status).toBe(429);
  });
});
