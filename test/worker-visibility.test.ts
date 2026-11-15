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
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let agentId: AgentId;
let token: string;
let n = 0;
const clock = new Date("2026-11-15T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-visibility-"));
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
  const op = await identity.createOperator({ kind: "organization", displayName: "Vis Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const agent = await identity.registerAgent(op.id, { displayName: "Vis Agent" });
  agentId = agent.id;
  token = (
    await new CredentialService(db, { now: () => clock }).issueCredential(agent.id, {
      label: "vis",
    })
  ).token;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Body {
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  quality?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

async function call(op: "get" | "search", body: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request(`https://example.com/v1/commons/${op}`, {
      method: "POST",
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
      RATE_LIMIT_AGENT_LIMIT: 10000,
      RATE_LIMIT_OPERATOR_LIMIT: 10000,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      NOW: () => clock,
    } as never,
  );
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Body };
}

const get = (id: string, version = 1, extra: Record<string, unknown> = {}) =>
  call("get", { contributionId: id, version, maxUtf8Bytes: 64000, ...extra });
const search = (query: string, extra: Record<string, unknown> = {}) =>
  call("search", { query, maxUtf8Bytes: 64000, ...extra });
const ids = (r: { body: Body }) =>
  (r.body.data.results as { contributionId: string }[]).map((x) => x.contributionId);

type Family = "knowledge" | "execution";
async function create(family: Family, word: string, related?: unknown[]): Promise<string> {
  const base = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const r = await registry.createContribution(agentId, {
    ...base,
    title: `${word} ${family} ${++n}`,
    ...(related ? { related } : {}),
  });
  if (!r.ok) throw new Error(`create failed: ${r.error.code}`);
  return r.contribution.id;
}
async function version(
  family: Family,
  id: string,
  prev: number,
  word: string,
  related?: unknown[],
) {
  const base = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const r = await registry.createContributionVersion(agentId, id, prev, {
    ...base,
    title: `${word} ${family} ${++n}`,
    ...(related ? { related } : {}),
  });
  if (!r.ok) throw new Error(`version failed: ${r.error.code}`);
}
const decide = async (
  id: string,
  v: number,
  to: "rejected" | "withdrawn" | "listed_unverified",
) => {
  const r = await new QualityReviewer(proxy.env, "rev").decide(id, v, to, "test");
  if (!r.ok) throw new Error(r.error.code);
};
const receipts = async () =>
  (await db.prepare("SELECT COUNT(*) AS c FROM retrieval_receipts").first<{ c: number }>())?.c;

const FAMILIES: Family[] = ["knowledge", "execution"];

describe("consumer visibility gate", () => {
  for (const family of FAMILIES) {
    it(`${family}: pending is hidden, listed_unverified is visible and labelled`, async () => {
      const word = `alphapending${family}`;
      const id = await create(family, word);
      expect(ids(await search(word))).toEqual([]);
      const denied = await get(id);
      expect(denied.status).toBe(404);
      expect(denied.body.error?.code).toBe("not_found");
      expect(denied.body.data).toBeUndefined();

      await listVersion(proxy.env, id);
      const found = await search(word);
      expect(ids(found)).toEqual([id]);
      expect(found.body.quality).toMatchObject({
        state: "listed_unverified",
        independentlyVerified: false,
      });
      const ok = await get(id);
      expect(ok.status).toBe(200);
      expect(ok.body.data.family).toBe(family);
      expect(ok.body.quality).toMatchObject({
        state: "listed_unverified",
        independentlyVerified: false,
      });
      expect(ok.text).not.toMatch(/"(verified|trusted)":\s*true/);
    });

    it(`${family}: pending v2 does not hide listed v1; v2 is not retrievable or searchable`, async () => {
      const id = await create(family, `betaone${family}`);
      await listVersion(proxy.env, id);
      await version(family, id, 1, `betatwozebrafish${family}`);

      const byOld = await search(`betaone${family}`);
      expect(ids(byOld)).toEqual([id]);
      expect(byOld.body.data.results[0].version).toBe(1);
      expect(ids(await search(`betatwozebrafish${family}`))).toEqual([]);

      const v2 = await get(id, 2);
      expect(v2.status).toBe(404);
      expect(v2.text).not.toContain("zebrafish");
      expect((await get(id, 1)).status).toBe(200);

      // Once v2 is listed it becomes the searched version.
      await decide(id, 2, "listed_unverified");
      expect(ids(await search(`betatwozebrafish${family}`))).toEqual([id]);
      expect(ids(await search(`betaone${family}`))).toEqual([]);
      const listedV2 = await get(id, 2);
      expect(listedV2.status).toBe(200);
      expect(listedV2.body.data.previousVersion).toBe(1);

      // Withdrawing v2 falls back to listed v1.
      await decide(id, 2, "withdrawn");
      expect(ids(await search(`betaone${family}`))).toEqual([id]);
      expect((await get(id, 2)).status).toBe(404);
    });

    it(`${family}: withdrawn and rejected versions disappear`, async () => {
      const w = await create(family, `gammawithdrawn${family}`);
      await listVersion(proxy.env, w);
      expect(ids(await search(`gammawithdrawn${family}`))).toEqual([w]);
      await decide(w, 1, "withdrawn");
      expect(ids(await search(`gammawithdrawn${family}`))).toEqual([]);
      expect((await get(w)).status).toBe(404);

      const r = await create(family, `gammarejected${family}`);
      await decide(r, 1, "rejected");
      expect(ids(await search(`gammarejected${family}`))).toEqual([]);
      expect((await get(r)).status).toBe(404);
    });

    it(`${family}: denied states, unknown IDs and missing state are indistinguishable`, async () => {
      const pending = await create(family, `deltapending${family}`);
      const rejected = await create(family, `deltarejected${family}`);
      await decide(rejected, 1, "rejected");
      const withdrawn = await create(family, `deltawithdrawn${family}`);
      await listVersion(proxy.env, withdrawn);
      await decide(withdrawn, 1, "withdrawn");
      const noState = await create(family, `deltanostate${family}`);
      await db.prepare("DROP TRIGGER IF EXISTS version_quality_states_no_delete").run();
      await db
        .prepare("DELETE FROM version_quality_states WHERE contribution_id = ?")
        .bind(noState)
        .run();
      const listed = await create(family, `deltalisted${family}`);
      await listVersion(proxy.env, listed);

      const before = await receipts();
      const responses = [
        await get(pending),
        await get(rejected),
        await get(withdrawn),
        await get(noState),
        await get("00000000-0000-4000-8000-000000000000"),
        await get(listed, 2),
      ];
      for (const r of responses) {
        expect(r.status).toBe(404);
        expect(r.text).toBe(responses[0]?.text);
      }
      expect(ids(await search(`deltanostate${family}`))).toEqual([]);

      // Conditional requests with the exact current hash cannot probe a non-listed version.
      for (const id of [pending, rejected, withdrawn, noState]) {
        const row = await db
          .prepare("SELECT content_hash FROM contribution_versions WHERE contribution_id = ?")
          .bind(id)
          .first<{ content_hash: string }>();
        const cond = await get(id, 1, {
          validator: { contributionId: id, version: 1, contentHash: row?.content_hash },
        });
        expect(cond.status).toBe(404);
        expect(cond.text).toBe(responses[0]?.text);
      }
      // Listed version still honours a matching validator.
      const hash = (await get(listed)).body.data.contentHash;
      const nm = await get(listed, 1, {
        validator: { contributionId: listed, version: 1, contentHash: hash },
      });
      expect(nm.body.data.schemaVersion).toBe("retrieval-not-modified/v1");
      expect(nm.body.quality).toMatchObject({ state: "listed_unverified" });

      // Only the single successful full retrieval above created a receipt.
      expect(await receipts()).toBe((before ?? 0) + 1);
    });
  }

  it("omits references and previous-version metadata for non-listed related versions", async () => {
    const k = await create("knowledge", "epsilonrefk");
    const e = await create("execution", "epsilonrefe", [
      { family: "knowledge", id: k, version: 1 },
    ]);
    await listVersion(proxy.env, e);

    const hidden = await get(e);
    expect(hidden.body.data.related).toEqual([]);
    expect(hidden.body.data.content.related).toEqual([]);
    expect(hidden.text).not.toContain(k);
    const s = await search("epsilonrefe");
    expect(s.body.data.results[0].related).toEqual([]);
    expect(s.text).not.toContain(k);

    await listVersion(proxy.env, k);
    const shown = await get(e);
    expect(shown.body.data.related).toEqual([{ family: "knowledge", id: k, version: 1 }]);
    expect(shown.body.data.content.related).toEqual([{ family: "knowledge", id: k, version: 1 }]);
    expect((await search("epsilonrefe")).body.data.results[0].related).toHaveLength(1);

    // previousVersion points at a pending v1 of a contribution whose v2 is listed.
    const k2 = await create("knowledge", "epsilonprev");
    await version("knowledge", k2, 1, "epsilonprevtwo");
    await decide(k2, 2, "listed_unverified");
    expect((await get(k2, 2)).body.data.previousVersion).toBeNull();
  });

  it("keeps the private reviewer inspect path available for non-listed versions", async () => {
    const id = await create("knowledge", "zetainspect");
    expect((await get(id)).status).toBe(404);
    const inspected = await new QualityReviewer(proxy.env, "rev").inspect(id, 1);
    expect(inspected.ok).toBe(true);
  });
});
