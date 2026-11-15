/**
 * Pre-deployment checks for the open unpaid pilot's Wrangler configuration.
 *
 * Pure and offline: it reads nothing from Cloudflare, creates nothing and never prints a
 * configuration value, so a mistakenly pasted secret is reported by path only. It reuses the
 * Worker's own parsers so a configuration that passes here is one the Worker accepts.
 */
import { isAcceptableReviewerToken } from "../review/routes";
import { resolveEnrollmentConfig } from "../enrollment/routes";
import { resolveMcpHttpConfig } from "../mcp/http";
import { parseExecutionDomainPolicy } from "../registry/execution";
import { parseKnowledgePermissionPolicy } from "../registry/knowledge-policy";

export type PilotPhase = "initial" | "pilot";

export interface PreflightInput {
  /** Raw text of the Wrangler JSONC file to check. */
  readonly configText: string;
  readonly phase: PilotPhase;
  /** File names found in the migrations directory (optional; skipped when undefined). */
  readonly migrationFiles?: readonly string[];
  /** Raw policy strings that belong to local test fixtures and must not be reused. */
  readonly forbiddenPolicies?: readonly string[];
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const ALLOWED_TOP_LEVEL = new Set([
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "account_id",
  "routes",
  "workers_dev",
  "preview_urls",
  "observability",
  "d1_databases",
  "r2_buckets",
  "vars",
]);
const ALLOWED_VARS = new Set([
  "PILOT_MODE",
  "ENROLLMENT",
  "ENROLLMENT_DOMAIN",
  "ENROLLMENT_URI",
  "ENROLLMENT_CHAIN_ID",
  "ENROLLMENT_CHALLENGE_TTL_SECONDS",
  "ENROLLMENT_IP_LIMIT",
  "ENROLLMENT_ADDRESS_LIMIT",
  "ENROLLMENT_GLOBAL_LIMIT",
  "REVIEW_INTERFACE",
  "REVIEWER_ID",
  "NEEDS_INTAKE",
  "NEEDS_INTAKE_OPERATOR_DAILY_LIMIT",
  "MCP_HTTP",
  "MCP_ALLOWED_HOSTNAMES",
  "RATE_LIMIT_AGENT_LIMIT",
  "RATE_LIMIT_OPERATOR_LIMIT",
  "RATE_LIMIT_WINDOW_SECONDS",
  "EXECUTION_DOMAIN_POLICY_JSON",
  "KNOWLEDGE_PERMISSION_POLICY_JSON",
]);
const SECRET_KEY =
  /token|secret|password|passwd|private|api[_-]?key|credential|signature|mnemonic|seed/i;
const PLACEHOLDER =
  /<[^<>\s]*>|\b(?:REPLACE|CHANGE|TODO|FIXME|EXAMPLE|PLACEHOLDER|YOUR)[A-Z_-]*\b/i;
const ANGLE_PLACEHOLDER = /<[A-Z0-9_]+>/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ON_OFF = new Set(["on", "off"]);
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const REQUIRED_MIGRATIONS = 11;

function dropTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Remove `//` and block comments and trailing commas outside strings, then parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(dropTrailingCommas(out)) as unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isPlaceholder(value: unknown, anglesOnly = false): boolean {
  if (typeof value !== "string" || value.trim() === "") return true;
  return (anglesOnly ? ANGLE_PLACEHOLDER : PLACEHOLDER).test(value);
}

function secretLooking(value: string): boolean {
  return (
    isAcceptableReviewerToken(value) ||
    /\bac1_[A-Za-z0-9_-]{8,}/.test(value) ||
    /\b0x[0-9a-fA-F]{64}\b/.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\bBearer\s+\S{8,}/i.test(value)
  );
}

function scanForSecrets(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (secretLooking(value)) errors.push(`${path}: value looks like a secret; remove it`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, errors));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) errors.push(`${path}.${k}: secret-like setting name is not allowed`);
      scanForSecrets(v, `${path}.${k}`, errors);
    }
  }
}

function checkBindings(config: Record<string, unknown>, errors: string[]): void {
  const dbs = config["d1_databases"];
  if (!Array.isArray(dbs) || dbs.length !== 1 || !isRecord(dbs[0])) {
    errors.push("d1_databases: exactly one D1 binding named DB is required");
  } else {
    const db = dbs[0];
    if (db["binding"] !== "DB") errors.push('d1_databases[0].binding: must be "DB"');
    if (isPlaceholder(db["database_name"])) {
      errors.push("d1_databases[0].database_name: missing or placeholder");
    }
    const id = db["database_id"];
    if (isPlaceholder(id) || typeof id !== "string" || !UUID.test(id)) {
      errors.push("d1_databases[0].database_id: must be the real D1 database UUID");
    } else if (/^[0-]+$/.test(id)) {
      errors.push("d1_databases[0].database_id: all-zero local placeholder");
    }
    if (db["migrations_dir"] !== "migrations") {
      errors.push('d1_databases[0].migrations_dir: must be "migrations"');
    }
  }
  const buckets = config["r2_buckets"];
  if (!Array.isArray(buckets) || buckets.length !== 1 || !isRecord(buckets[0])) {
    errors.push("r2_buckets: exactly one R2 binding named CONTENT_BUCKET is required");
  } else {
    const b = buckets[0];
    if (b["binding"] !== "CONTENT_BUCKET") {
      errors.push('r2_buckets[0].binding: must be "CONTENT_BUCKET"');
    }
    const name = b["bucket_name"];
    if (isPlaceholder(name) || typeof name !== "string" || !BUCKET.test(name)) {
      errors.push("r2_buckets[0].bucket_name: missing, placeholder or not a valid R2 bucket name");
    } else if (/(^|-)(local|test)(-|$)/.test(name)) {
      errors.push("r2_buckets[0].bucket_name: looks like a local or test bucket");
    }
  }
}

function checkPolicies(
  vars: Record<string, unknown>,
  forbidden: readonly string[],
  errors: string[],
): void {
  const specs = [
    ["EXECUTION_DOMAIN_POLICY_JSON", parseExecutionDomainPolicy] as const,
    ["KNOWLEDGE_PERMISSION_POLICY_JSON", parseKnowledgePermissionPolicy] as const,
  ];
  for (const [key, parse] of specs) {
    const raw = vars[key];
    if (isPlaceholder(raw, true)) {
      errors.push(`vars.${key}: must be set to a reviewed pilot policy (placeholder or missing)`);
      continue;
    }
    const parsed = parse(raw);
    if (!parsed.ok) {
      errors.push(`vars.${key}: invalid policy (${parsed.errors.length} error(s))`);
      continue;
    }
    const empty =
      "permittedCombinations" in parsed.policy
        ? parsed.policy.permittedCombinations.length === 0
        : parsed.policy.allowed.length === 0;
    if (empty) errors.push(`vars.${key}: policy permits nothing`);
    if (forbidden.some((f) => sameJson(f, raw as string))) {
      errors.push(`vars.${key}: equals a local test fixture policy; make a pilot decision`);
    }
  }
}

function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)));
  } catch {
    return a === b;
  }
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isRecord(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  }
  return v;
}

function checkSettings(vars: Record<string, unknown>, phase: PilotPhase, errors: string[]): void {
  for (const key of Object.keys(vars)) {
    if (!ALLOWED_VARS.has(key)) errors.push(`vars.${key}: unknown setting`);
  }
  const mode = vars["PILOT_MODE"];
  if (mode !== "read-only" && mode !== "off") {
    errors.push('vars.PILOT_MODE: must be explicitly "read-only" or "off"');
  }
  for (const key of ["ENROLLMENT", "REVIEW_INTERFACE", "NEEDS_INTAKE"] as const) {
    const v = vars[key];
    if (typeof v !== "string" || !ON_OFF.has(v)) {
      errors.push(`vars.${key}: must be explicitly "on" or "off"`);
    }
  }
  // Remote MCP is optional in older local copies (absent means off) but never implicit.
  const mcp = vars["MCP_HTTP"];
  if (mcp !== undefined && (typeof mcp !== "string" || !ON_OFF.has(mcp))) {
    errors.push('vars.MCP_HTTP: must be explicitly "on" or "off" when present');
  }
  const on = (k: string) => vars[k] === "on";

  if (phase === "initial") {
    if (mode !== "read-only") errors.push('initial phase: PILOT_MODE must be "read-only"');
    for (const key of ["ENROLLMENT", "REVIEW_INTERFACE", "NEEDS_INTAKE", "MCP_HTTP"]) {
      if (on(key)) errors.push(`initial phase: ${key} must be "off"`);
    }
    return;
  }
  if (on("MCP_HTTP")) {
    const hosts = vars["MCP_ALLOWED_HOSTNAMES"];
    if (
      resolveMcpHttpConfig({ MCP_HTTP: "on", MCP_ALLOWED_HOSTNAMES: hosts as string }).state !==
      "on"
    ) {
      errors.push("vars.MCP_ALLOWED_HOSTNAMES: missing or invalid while MCP_HTTP is on");
    } else if (
      isPlaceholder(hosts) ||
      /(^|,|\.)(example\.[a-z]+|localhost|test|invalid)(,|$)|127\.0\.0\.1/i.test(String(hosts))
    ) {
      errors.push("vars.MCP_ALLOWED_HOSTNAMES: placeholder, example or local value");
    }
  }
  if (on("REVIEW_INTERFACE")) {
    const id = vars["REVIEWER_ID"];
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(id) ||
      isPlaceholder(id)
    ) {
      errors.push("vars.REVIEWER_ID: required and valid when REVIEW_INTERFACE is on");
    }
  }
  if (on("ENROLLMENT")) {
    if (resolveEnrollmentConfig(vars) === null) {
      errors.push(
        "vars.ENROLLMENT_DOMAIN/ENROLLMENT_URI/ENROLLMENT_CHAIN_ID: missing or invalid while ENROLLMENT is on",
      );
    }
    for (const key of ["ENROLLMENT_DOMAIN", "ENROLLMENT_URI"]) {
      if (isPlaceholder(vars[key]) || /example\.|localhost|127\.0\.0\.1/i.test(String(vars[key]))) {
        errors.push(`vars.${key}: placeholder, example or local value`);
      }
    }
    if (!on("REVIEW_INTERFACE")) {
      errors.push(
        "ENROLLMENT on requires REVIEW_INTERFACE on: no contribution may wait unreviewed",
      );
    }
    if (mode !== "off") {
      errors.push(
        'ENROLLMENT on requires PILOT_MODE "off", otherwise enrolled agents cannot contribute',
      );
    }
  }
  if (mode === "off" && !on("REVIEW_INTERFACE")) {
    errors.push('PILOT_MODE "off" accepts contributions and requires REVIEW_INTERFACE on');
  }
}

function checkMigrations(files: readonly string[], errors: string[]): void {
  const numbers = files
    .map((f) => MIGRATION_FILE.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const contiguous = numbers.every((n, i) => n === i + 1);
  if (numbers.length < REQUIRED_MIGRATIONS || !contiguous) {
    errors.push(
      `migrations: expected contiguous 0001–${String(REQUIRED_MIGRATIONS).padStart(4, "0")} or later`,
    );
  }
}

export function preflight(input: PreflightInput): PreflightResult {
  const errors: string[] = [];
  let config: unknown;
  try {
    config = parseJsonc(input.configText);
  } catch {
    return { ok: false, errors: ["config: not valid JSON with comments"] };
  }
  if (!isRecord(config)) return { ok: false, errors: ["config: must be an object"] };

  for (const key of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) errors.push(`${key}: unexpected top-level setting`);
  }
  if (isPlaceholder(config["name"])) errors.push("name: missing or placeholder");
  if (config["main"] !== "src/index.ts") errors.push('main: must be "src/index.ts"');
  if (typeof config["compatibility_date"] !== "string") {
    errors.push("compatibility_date: required");
  }
  scanForSecrets(config, "config", errors);
  checkBindings(config, errors);

  const vars = config["vars"];
  if (!isRecord(vars)) {
    errors.push("vars: required");
  } else {
    checkSettings(vars, input.phase, errors);
    checkPolicies(vars, input.forbiddenPolicies ?? [], errors);
  }
  if (input.migrationFiles) checkMigrations(input.migrationFiles, errors);
  return { ok: errors.length === 0, errors };
}
