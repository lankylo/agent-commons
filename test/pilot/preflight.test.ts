import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc, preflight, type PilotPhase } from "../../src/pilot/preflight";

const template = readFileSync("wrangler.pilot.template.jsonc", "utf8");
const migrationFiles = readdirSync("migrations");
const local = parseJsonc(readFileSync("wrangler.registry-local.jsonc", "utf8")) as {
  vars: Record<string, string>;
};
const forbiddenPolicies = Object.values(local.vars);

const EXEC = JSON.stringify({
  allowed: [{ domain: "api.pilot-partner.dev", includeSubdomains: false }],
  denied: [],
});
const KNOW = JSON.stringify({
  permittedCombinations: [
    { sourceLicense: "CC0-1.0", permittedUse: "summary", dataPermission: "redistribution-allowed" },
  ],
});
const TOKEN = "Zx9_Qw3-Er7tYu1IoP5aSd8FgH2jKl4MnB6vCx0ZqW9eR";

function config(overrides: {
  vars?: Record<string, unknown>;
  top?: Record<string, unknown>;
  db?: Record<string, unknown>;
  bucket?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    name: "agent-commons-pilot",
    main: "src/index.ts",
    compatibility_date: "2025-01-01",
    d1_databases: [
      {
        binding: "DB",
        database_name: "commons-pilot",
        database_id: "5b0c6d1e-2f3a-4b5c-8d7e-9f0a1b2c3d4e",
        migrations_dir: "migrations",
        ...overrides.db,
      },
    ],
    r2_buckets: [
      { binding: "CONTENT_BUCKET", bucket_name: "commons-pilot-content", ...overrides.bucket },
    ],
    vars: {
      PILOT_MODE: "read-only",
      ENROLLMENT: "off",
      REVIEW_INTERFACE: "off",
      NEEDS_INTAKE: "off",
      EXECUTION_DOMAIN_POLICY_JSON: EXEC,
      KNOWLEDGE_PERMISSION_POLICY_JSON: KNOW,
      ...overrides.vars,
    },
    ...overrides.top,
  });
}
const run = (text: string, phase: PilotPhase = "initial") =>
  preflight({ configText: text, phase, migrationFiles, forbiddenPolicies });
const OPEN = {
  PILOT_MODE: "off",
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: "commons.pilot-host.dev",
  ENROLLMENT_URI: "https://commons.pilot-host.dev/",
  ENROLLMENT_CHAIN_ID: "1",
  REVIEW_INTERFACE: "on",
  REVIEWER_ID: "operator-1",
};

describe("pilot preflight", () => {
  it("rejects the committed template for placeholders only, with disabled settings", () => {
    const r = run(template);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/database_id/);
    expect(r.errors.join("\n")).toMatch(/bucket_name/);
    expect(r.errors.filter((e) => /POLICY_JSON/.test(e))).toHaveLength(2);
    expect(
      r.errors.every((e) => /placeholder|database_id|bucket_name|set to a reviewed/.test(e)),
    ).toBe(true);
  });

  it("keeps account IDs, hostnames, routes and secrets out of the template", () => {
    const t = parseJsonc(template) as Record<string, unknown>;
    expect(t).not.toHaveProperty("account_id");
    expect(t).not.toHaveProperty("routes");
    expect(template).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(template).not.toMatch(/https?:\/\//);
    const vars = t["vars"] as Record<string, string>;
    expect(vars).toMatchObject({
      PILOT_MODE: "read-only",
      ENROLLMENT: "off",
      REVIEW_INTERFACE: "off",
      NEEDS_INTAKE: "off",
    });
    expect(Object.keys(vars).some((k) => /token/i.test(k))).toBe(false);
    for (const policy of forbiddenPolicies) expect(template).not.toContain(policy);
  });

  it("accepts a complete initial configuration and a complete open-pilot one", () => {
    expect(run(config({}))).toEqual({ ok: true, errors: [] });
    expect(run(config({ vars: OPEN }), "pilot")).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["missing D1 id", { db: { database_id: undefined } }, /database_id/],
    ["placeholder D1 id", { db: { database_id: "<D1_DATABASE_ID>" } }, /database_id/],
    ["zero D1 id", { db: { database_id: "00000000-0000-0000-0000-000000000000" } }, /all-zero/],
    ["wrong D1 binding", { db: { binding: "DATABASE" } }, /"DB"/],
    ["placeholder bucket", { bucket: { bucket_name: "<R2_BUCKET_NAME>" } }, /bucket_name/],
    ["local bucket", { bucket: { bucket_name: "agent-commons-content-local" } }, /local or test/],
    ["wrong R2 binding", { bucket: { binding: "BUCKET" } }, /CONTENT_BUCKET/],
    ["unexpected binding", { top: { kv_namespaces: [] } }, /kv_namespaces/],
  ])("catches %s", (_n, overrides, pattern) => {
    const r = run(config(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(pattern);
  });

  it("fails closed on missing, placeholder, invalid, empty and local-fixture policies", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ EXECUTION_DOMAIN_POLICY_JSON: undefined }, /EXECUTION_DOMAIN_POLICY_JSON/],
      [{ KNOWLEDGE_PERMISSION_POLICY_JSON: "<REVIEWED_X>" }, /KNOWLEDGE_PERMISSION_POLICY_JSON/],
      [{ EXECUTION_DOMAIN_POLICY_JSON: "{not json" }, /invalid policy/],
      [
        { EXECUTION_DOMAIN_POLICY_JSON: '{"allowed":[],"denied":[]}' },
        /permits nothing|invalid policy/,
      ],
      [
        { KNOWLEDGE_PERMISSION_POLICY_JSON: '{"permittedCombinations":[]}' },
        /permits nothing|invalid policy/,
      ],
      [
        { EXECUTION_DOMAIN_POLICY_JSON: local.vars["EXECUTION_DOMAIN_POLICY_JSON"] },
        /local test fixture/,
      ],
      [
        { KNOWLEDGE_PERMISSION_POLICY_JSON: local.vars["KNOWLEDGE_PERMISSION_POLICY_JSON"] },
        /local test fixture/,
      ],
    ];
    for (const [vars, pattern] of cases) {
      const r = run(config({ vars }));
      expect(r.ok, JSON.stringify(vars)).toBe(false);
      expect(r.errors.join("\n")).toMatch(pattern);
    }
  });

  it("requires the initial phase to keep everything disabled", () => {
    for (const vars of [
      { PILOT_MODE: "off" },
      { ENROLLMENT: "on" },
      { REVIEW_INTERFACE: "on" },
      { NEEDS_INTAKE: "on" },
      { MCP_HTTP: "on", MCP_ALLOWED_HOSTNAMES: "commons.pilot-host.dev" },
    ]) {
      expect(run(config({ vars })).ok).toBe(false);
    }
  });

  it("rejects missing or invalid pilot settings", () => {
    for (const vars of [
      { PILOT_MODE: undefined },
      { PILOT_MODE: "Read-Only" },
      { ENROLLMENT: undefined },
      { ENROLLMENT: "true" },
      { REVIEW_INTERFACE: "ON" },
      { NEEDS_INTAKE: "" },
      { MCP_HTTP: "" },
      { MCP_HTTP: "ON" },
      { UNKNOWN_SETTING: "x" },
    ]) {
      expect(run(config({ vars })).ok, JSON.stringify(vars)).toBe(false);
    }
  });

  it("validates open-pilot enablement", () => {
    const bad: Array<Record<string, unknown>> = [
      { ENROLLMENT_DOMAIN: undefined },
      { ENROLLMENT_CHAIN_ID: "0" },
      { ENROLLMENT_URI: "https://other.pilot-host.dev/" },
      { ENROLLMENT_DOMAIN: "commons.example.org", ENROLLMENT_URI: "https://commons.example.org/" },
      { ENROLLMENT_DOMAIN: "<HOSTNAME>", ENROLLMENT_URI: "<URI>" },
      { REVIEWER_ID: undefined },
      { REVIEWER_ID: "bad id" },
      { REVIEW_INTERFACE: "off" },
      { PILOT_MODE: "read-only" },
    ];
    for (const v of bad) {
      expect(run(config({ vars: { ...OPEN, ...v } }), "pilot").ok, JSON.stringify(v)).toBe(false);
    }
  });

  it("keeps remote MCP off in the template and validates its hostnames when enabled", () => {
    expect(template).toMatch(/"MCP_HTTP": "off"/);
    expect(template).not.toMatch(/MCP_ALLOWED_HOSTNAMES"\s*:/);
    expect(run(config({ vars: { MCP_HTTP: undefined } })).ok).toBe(true);
    expect(run(config({ vars: { MCP_HTTP: "off" } })).ok).toBe(true);
    const mcp = { MCP_HTTP: "on", MCP_ALLOWED_HOSTNAMES: "commons.pilot-host.dev" };
    expect(run(config({ vars: { ...OPEN, ...mcp } }), "pilot").ok).toBe(true);
    for (const hosts of [
      undefined,
      "",
      "https://commons.pilot-host.dev",
      "commons.pilot-host.dev:443",
      "*.pilot-host.dev",
      "<MCP_HOSTNAME>",
      "localhost",
      "commons.example.com",
      "commons.pilot-host.dev,commons.test",
    ]) {
      const vars = { ...OPEN, ...mcp, MCP_ALLOWED_HOSTNAMES: hosts };
      expect(run(config({ vars }), "pilot").ok, String(hosts)).toBe(false);
    }
  });

  it("detects accidental secrets without echoing their values", () => {
    const secretCases: Array<Record<string, unknown>> = [
      { vars: { REVIEWER_TOKEN: TOKEN } },
      { vars: { REVIEWER_ID: TOKEN } },
      { vars: { ENROLLMENT_URI: "ac1_abcdefghijklmnop" } },
      { vars: { NOTE: `0x${"ab".repeat(32)}` } },
      { top: { secrets: { REVIEWER_TOKEN: "x" } } },
    ];
    for (const overrides of secretCases) {
      const r = run(config(overrides));
      expect(r.ok).toBe(false);
      const text = r.errors.join("\n");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("ac1_abcdefghijklmnop");
      expect(text).not.toContain("ab".repeat(32));
    }
    expect(run(config({ vars: { REVIEWER_TOKEN: TOKEN } })).errors.join("\n")).toMatch(/secret/);
  });

  it("requires contiguous migrations through 0012", () => {
    const text = config({});
    const base = { configText: text, phase: "initial" as const, forbiddenPolicies };
    expect(preflight({ ...base, migrationFiles }).ok).toBe(true);
    expect(preflight({ ...base, migrationFiles: migrationFiles.slice(0, 10) }).ok).toBe(false);
    expect(
      preflight({ ...base, migrationFiles: migrationFiles.filter((f) => !f.startsWith("0005")) })
        .ok,
    ).toBe(false);
  });

  it("rejects unparseable configuration", () => {
    expect(run("{ nope").ok).toBe(false);
    expect(run("[]").ok).toBe(false);
  });

  it("parses JSONC comments and trailing commas without touching strings", () => {
    expect(parseJsonc('{ // c\n "a": "x//y,}", /* b */ "b": [1,], }')).toEqual({
      a: "x//y,}",
      b: [1],
    });
  });
});
