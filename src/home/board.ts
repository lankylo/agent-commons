/**
 * Public board feed (`GET /v1/public/board`) for the homepage map.
 *
 * Owner decision 2026-11-22: the public homepage may show each listed record's title, family,
 * content type, topic, verification status, price and listing date, plus aggregate counts and a
 * short activity log. Content, facts, sources and recipe steps stay behind an enrolled credential
 * and, where priced, a purchase. Pending, rejected and withdrawn versions never appear, and no
 * operator, agent or wallet identity is exposed.
 *
 * Served only while wallet enrollment is enabled and valid (same rule as the onboarding document).
 * Verification comes from {@link TrustStore}, so the board and search can never disagree.
 */
import { resolveEnrollmentConfig, type EnrollmentEnv } from "../enrollment/routes";
import {
  PAID_PRICE_LIST,
  PILOT_PRICE_LIST,
  VERIFICATION_REWARD,
  type ContentFamily,
} from "../payments/pricing";
import { resolvePaymentsMode } from "../payments/provider";
import { TrustStore, trustKey } from "../registry/trust";

export const BOARD_PATH = "/v1/public/board";
export const BOARD_LIMITS = { records: 500, activity: 20 } as const;
const CACHE_MS = 60_000;

export const TOPICS = [
  "Node.js",
  "Git & GitHub",
  "Python",
  "HTTP diagnostics",
  "Dev tooling",
  "APIs & more",
] as const;
export type Topic = (typeof TOPICS)[number];

const TOPIC_RULES: readonly (readonly [RegExp, Topic])[] = [
  [/\bnode(\.js)?\b|\bnpm\b/i, "Node.js"],
  [/\bgit\b|github|\bssh\b/i, "Git & GitHub"],
  [/\bpip\b|pypi|python/i, "Python"],
  [/httpbin|\bhttp client\b/i, "HTTP diagnostics"],
  [/eslint|docker|typescript|prettier|vite|webpack/i, "Dev tooling"],
];

/** Deterministic topic for the map district a record belongs to. */
export function topicFor(title: string): Topic {
  for (const [pattern, topic] of TOPIC_RULES) {
    if (pattern.test(title)) return topic;
  }
  return "APIs & more";
}

export type BoardStatus = "verified" | "awaiting_validator" | "listed";

export interface BoardRecord {
  readonly contributionId: string;
  readonly version: number;
  readonly family: ContentFamily;
  readonly contentType: string;
  readonly title: string;
  readonly topic: Topic;
  readonly status: BoardStatus;
  readonly priceMinor: number;
  /** Verification reward an outside validator can still earn, in USDC base units. */
  readonly rewardMinor: number;
  readonly listedAt: string;
}

export interface BoardActivity {
  readonly kind: "listed" | "platform_validated" | "verified";
  readonly at: string;
  readonly title: string;
  readonly family: ContentFamily;
}

export interface Board {
  readonly schemaVersion: "public-board/v1";
  readonly generatedAt: string;
  readonly payments: { readonly mode: string | null; readonly currency: "USDC" };
  readonly counts: {
    readonly listed: number;
    readonly knowledge: number;
    readonly execution: number;
    readonly verified: number;
    readonly openRewards: number;
    readonly openRewardsMinor: number;
  };
  readonly records: readonly BoardRecord[];
  readonly activity: readonly BoardActivity[];
}

export interface BoardEnv extends EnrollmentEnv {
  readonly DB?: D1Database;
  readonly PAYMENTS?: string;
  readonly NOW?: () => Date;
}

/** Latest listed version of each contribution, newest listing first. */
const RECORDS_SQL = `WITH listed AS (
  SELECT v.contribution_id AS id, v.version AS version, v.family AS family,
         v.content_type AS content_type, v.title AS title, q.updated_at AS listed_at,
         ROW_NUMBER() OVER (PARTITION BY v.contribution_id ORDER BY v.version DESC) AS rn
    FROM contribution_versions v
    JOIN version_quality_states q
      ON q.contribution_id = v.contribution_id AND q.version = v.version
     AND q.state = 'listed_unverified'
)
SELECT id, version, family, content_type, title, listed_at
  FROM listed WHERE rn = 1
 ORDER BY listed_at DESC, id
 LIMIT ?1`;

const LISTED = (alias: string) => `EXISTS (SELECT 1 FROM version_quality_states q
     WHERE q.contribution_id = ${alias}.contribution_id AND q.version = ${alias}.version
       AND q.state = 'listed_unverified')`;

/** Public events on listed versions only: listing, platform validation, outside verification. */
const ACTIVITY_SQL = `SELECT kind, at, title, family FROM (
  SELECT 'listed' AS kind, q.updated_at AS at, v.title AS title, v.family AS family
    FROM version_quality_states q
    JOIN contribution_versions v
      ON v.contribution_id = q.contribution_id AND v.version = q.version
   WHERE q.state = 'listed_unverified'
  UNION ALL
  SELECT 'platform_validated', pv.created_at, v.title, v.family
    FROM platform_validations pv
    JOIN contribution_versions v
      ON v.contribution_id = pv.contribution_id AND v.version = pv.version
   WHERE pv.action = 'validate' AND ${LISTED("v")}
  UNION ALL
  SELECT 'verified', e.created_at, v.title, v.family
    FROM ledger_entries e
    JOIN contribution_versions v
      ON v.contribution_id = e.contribution_id AND v.version = e.version
   WHERE e.entry_type = 'task_earning' AND ${LISTED("v")}
)
ORDER BY at DESC
LIMIT ?1`;

interface RecordRow {
  id: string;
  version: number;
  family: string;
  content_type: string;
  title: string;
  listed_at: string;
}

interface ActivityRow {
  kind: string;
  at: string;
  title: string;
  family: string;
}

const isFamily = (value: string): value is ContentFamily =>
  value === "knowledge" || value === "execution";

export async function buildBoard(db: D1Database, env: BoardEnv, now: Date): Promise<Board> {
  const mode = resolvePaymentsMode(env.PAYMENTS) ?? null;
  const paid = mode === "sandbox" || mode === "live";
  const prices = paid ? PAID_PRICE_LIST : PILOT_PRICE_LIST;

  const [recordRows, activityRows] = await Promise.all([
    db.prepare(RECORDS_SQL).bind(BOARD_LIMITS.records).all<RecordRow>(),
    db.prepare(ACTIVITY_SQL).bind(BOARD_LIMITS.activity).all<ActivityRow>(),
  ]);
  const rows = recordRows.results.filter((r) => isFamily(r.family));
  const trust = await new TrustStore(db, () => now).read(
    rows.map((r) => ({ id: r.id, version: r.version })),
  );

  const records: BoardRecord[] = rows.map((row) => {
    const family = row.family as ContentFamily;
    const t = trust.get(trustKey(row.id, row.version));
    const verified = t?.verified ?? false;
    const validated = t?.checks.includes("platform_validated") ?? false;
    const status: BoardStatus = verified
      ? "verified"
      : family === "execution" && validated
        ? "awaiting_validator"
        : "listed";
    return {
      contributionId: row.id,
      version: row.version,
      family,
      contentType: row.content_type,
      title: row.title,
      topic: topicFor(row.title),
      status,
      priceMinor: prices(family, verified).amountMinor,
      rewardMinor: status === "awaiting_validator" && paid ? VERIFICATION_REWARD.totalMinor : 0,
      listedAt: row.listed_at,
    };
  });

  const activity: BoardActivity[] = [];
  for (const a of activityRows.results) {
    if (!isFamily(a.family)) continue;
    activity.push({
      kind: a.kind as BoardActivity["kind"],
      at: a.at,
      title: a.title,
      family: a.family,
    });
  }

  const open = records.filter((r) => r.status === "awaiting_validator");
  return {
    schemaVersion: "public-board/v1",
    generatedAt: now.toISOString(),
    payments: { mode, currency: "USDC" },
    counts: {
      listed: records.length,
      knowledge: records.filter((r) => r.family === "knowledge").length,
      execution: records.filter((r) => r.family === "execution").length,
      verified: records.filter((r) => r.status === "verified").length,
      openRewards: open.length,
      openRewardsMinor: open.reduce((sum, r) => sum + r.rewardMinor, 0),
    },
    records,
    activity,
  };
}

/** Short per-isolate cache so a busy homepage costs at most one D1 read per minute. */
const cache = new WeakMap<D1Database, { at: number; body: string }>();

const headers = {
  "Cache-Control": "public, max-age=60",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
};

/** Serves the public board, or returns null for any other path. */
export async function handleBoard(request: Request, env: BoardEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== BOARD_PATH) return null;
  const config = resolveEnrollmentConfig(env);
  if (config === false || request.method !== "GET") {
    return new Response("Not Found", { status: 404 });
  }
  if (config === null || !env.DB) return new Response("Service Unavailable", { status: 503 });
  const now = env.NOW?.() ?? new Date();
  const hit = cache.get(env.DB);
  if (hit && now.getTime() - hit.at < CACHE_MS && now.getTime() >= hit.at) {
    return new Response(hit.body, { headers });
  }
  try {
    const body = JSON.stringify(await buildBoard(env.DB, env, now));
    cache.set(env.DB, { at: now.getTime(), body });
    return new Response(body, { headers });
  } catch {
    return new Response("Service Unavailable", { status: 503 });
  }
}
