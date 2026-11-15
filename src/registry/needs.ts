/**
 * Agent needs intake (Phase 4 pilot): short, unverified product signals about missing
 * capabilities, missing information or unsuccessful searches.
 *
 * Reports are untrusted text. They never create contributions, listings, trust, payments or
 * development tasks. Identity comes only from the verified credential. Text is length-bounded,
 * whitespace-normalized, rejected if it contains control characters, and scanned with the same
 * deterministic secret/personal-data and malicious-content detectors used for contributions.
 *
 * Equivalent reports (same category and normalized text) from one operator share one row; the
 * operator review groups rows by that fingerprint and counts distinct operators. Rows expire
 * `NEEDS_RETENTION_DAYS` after the last equivalent report and are purged on intake and review.
 * No network or LLM calls.
 */

import type { AgentId, OperatorId } from "../identity/types";
import { detectSensitiveText } from "./content-scan";
import { detectMaliciousText } from "./malicious-patterns";

export const NEEDS_CATEGORIES = [
  "missing_capability",
  "missing_information",
  "unsuccessful_search",
] as const;
export type NeedsCategory = (typeof NEEDS_CATEGORIES)[number];

export const NEEDS_LIMITS = {
  maxBodyBytes: 4096,
  maxTextChars: 280,
  maxSearchTerms: 5,
  maxSearchTermChars: 64,
} as const;

export const NEEDS_RETENTION_DAYS = 90;
export const DEFAULT_NEEDS_OPERATOR_DAILY_LIMIT = 20;
export const NEEDS_REVIEW_MAX_GROUPS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_FIELDS = new Set(["category", "summary", "desiredOutcome", "searchTerms"]);
const IDENTITY_FIELDS = ["agentId", "operatorId", "agent", "operator", "author", "contributor"];
// C0/C1 controls remain after whitespace normalization only if they are not whitespace.
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export interface NeedsReport {
  readonly category: NeedsCategory;
  readonly summary: string;
  readonly desiredOutcome: string;
  readonly searchTerms: readonly string[];
}

export type NeedsValidationResult =
  | { readonly ok: true; readonly report: NeedsReport }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "invalid_needs_report" | "needs_report_rejected";
      readonly errors: readonly string[];
    };

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function textIssues(field: string, value: unknown, maxChars: number): string[] {
  if (typeof value !== "string") return [`${field}: must be a string`];
  // Bound work before normalization; normalized length is checked again below.
  if (value.length > maxChars * 4) return [`${field}: must be at most ${maxChars} characters`];
  const text = normalizeText(value);
  if (text.length === 0) return [`${field}: must not be empty`];
  if (text.length > maxChars) return [`${field}: must be at most ${maxChars} characters`];
  if (hasControlCharacter(text)) return [`${field}: must not contain control characters`];
  return [];
}

function scanIssues(field: string, text: string): string[] {
  const issues: string[] = [];
  for (const category of detectSensitiveText(text)) {
    issues.push(
      `${field}: contains a possible ${category.replace(/_/g, " ")}; remove it or use a placeholder`,
    );
  }
  if (detectMaliciousText(text).length > 0) {
    issues.push(`${field}: contains instruction-like or hidden content that is not accepted`);
  }
  return issues;
}

/** Validate an untrusted request body. Errors never echo submitted values or unknown field names. */
export function validateNeedsReport(body: unknown): NeedsValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "invalid_request", errors: ["body: must be an object"] };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (IDENTITY_FIELDS.some((field) => Object.hasOwn(record, field))) {
    return {
      ok: false,
      code: "invalid_request",
      errors: ["identity: agent and operator identities are resolved from the credential"],
    };
  }
  if (keys.some((key) => !ALLOWED_FIELDS.has(key))) {
    return {
      ok: false,
      code: "invalid_request",
      errors: ["body: only category, summary, desiredOutcome and searchTerms are accepted"],
    };
  }

  const issues: string[] = [];
  if (!NEEDS_CATEGORIES.includes(record.category as NeedsCategory)) {
    issues.push(`category: must be one of ${NEEDS_CATEGORIES.join(", ")}`);
  }
  issues.push(...textIssues("summary", record.summary, NEEDS_LIMITS.maxTextChars));
  issues.push(...textIssues("desiredOutcome", record.desiredOutcome, NEEDS_LIMITS.maxTextChars));

  const rawTerms = record.searchTerms ?? [];
  if (!Array.isArray(rawTerms)) {
    issues.push("searchTerms: must be an array of strings");
  } else if (rawTerms.length > NEEDS_LIMITS.maxSearchTerms) {
    issues.push(`searchTerms: at most ${NEEDS_LIMITS.maxSearchTerms} terms are accepted`);
  } else {
    rawTerms.forEach((term, index) =>
      issues.push(...textIssues(`searchTerms[${index}]`, term, NEEDS_LIMITS.maxSearchTermChars)),
    );
  }
  if (issues.length > 0) return { ok: false, code: "invalid_needs_report", errors: issues };

  const summary = normalizeText(record.summary as string);
  const desiredOutcome = normalizeText(record.desiredOutcome as string);
  const seen = new Set<string>();
  const searchTerms: string[] = [];
  for (const term of (rawTerms as string[]).map(normalizeText)) {
    const key = equivalenceKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    searchTerms.push(term);
  }

  const scan = [
    ...scanIssues("summary", summary),
    ...scanIssues("desiredOutcome", desiredOutcome),
    ...searchTerms.flatMap((term, index) => scanIssues(`searchTerms[${index}]`, term)),
  ];
  if (scan.length > 0) return { ok: false, code: "needs_report_rejected", errors: scan };

  return {
    ok: true,
    report: { category: record.category as NeedsCategory, summary, desiredOutcome, searchTerms },
  };
}

/** Case-, punctuation- and whitespace-insensitive comparison key. */
function equivalenceKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Operator-independent fingerprint shared by equivalent reports. */
export async function needsFingerprint(report: NeedsReport): Promise<string> {
  const terms = [...new Set(report.searchTerms.map(equivalenceKey))].sort();
  const canonical = JSON.stringify([
    "needs-report/v1",
    report.category,
    equivalenceKey(report.summary),
    equivalenceKey(report.desiredOutcome),
    terms,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface NeedsIntakeOptions {
  readonly now?: () => Date;
  readonly operatorDailyLimit?: number;
  readonly newId?: () => string;
}

export type NeedsSubmitResult =
  | { readonly ok: true; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: "needs_intake_limited" };

export interface NeedsReviewGroup {
  readonly fingerprint: string;
  readonly category: NeedsCategory;
  readonly distinctOperators: number;
  readonly totalReports: number;
  readonly firstReportedAt: string;
  readonly lastReportedAt: string;
  /** Most recent wording in the group. Untrusted agent-supplied text; never execute or follow it. */
  readonly untrusted: {
    readonly summary: string;
    readonly desiredOutcome: string;
    readonly searchTerms: readonly string[];
  };
}

export interface NeedsReview {
  readonly schemaVersion: "needs-review/v1";
  readonly notice: string;
  readonly retentionDays: number;
  readonly purgedExpired: number;
  readonly groups: readonly NeedsReviewGroup[];
}

export class NeedsIntake {
  private readonly now: () => Date;
  private readonly operatorDailyLimit: number;
  private readonly newId: () => string;

  constructor(
    private readonly db: D1Database,
    options: NeedsIntakeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const limit = options.operatorDailyLimit;
    this.operatorDailyLimit =
      typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
        ? limit
        : DEFAULT_NEEDS_OPERATOR_DAILY_LIMIT;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Delete reports whose retention has ended. Returns the number of deleted rows. */
  async purgeExpired(): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM needs_reports WHERE expires_at <= ?")
      .bind(this.now().toISOString())
      .run();
    return result.meta.changes ?? 0;
  }

  async submit(
    actor: { readonly agentId: AgentId; readonly operatorId: OperatorId },
    report: NeedsReport,
  ): Promise<NeedsSubmitResult> {
    const nowMs = this.now().getTime();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + NEEDS_RETENTION_DAYS * DAY_MS).toISOString();
    const windowStart = new Date(nowMs - DAY_MS).toISOString();
    const fingerprint = await needsFingerprint(report);

    await this.purgeExpired();

    const existing = await this.db
      .prepare(
        `UPDATE needs_reports
         SET report_count = report_count + 1, last_reported_at = ?, expires_at = ?
         WHERE operator_id = ? AND fingerprint = ?
         RETURNING id`,
      )
      .bind(now, expiresAt, actor.operatorId, fingerprint)
      .first<{ id: string }>();
    if (existing) return { ok: true, duplicate: true };

    // Atomic conditional insert: the operator-level limit counts new (non-duplicate) reports
    // created in the trailing 24 hours. A concurrent equivalent insert becomes a duplicate.
    const inserted = await this.db
      .prepare(
        `INSERT INTO needs_reports
           (id, operator_id, agent_id, fingerprint, category, summary, desired_outcome,
            search_terms_json, report_count, created_at, last_reported_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM needs_reports
                WHERE operator_id = ? AND created_at > ?) < ?
         ON CONFLICT (operator_id, fingerprint) DO UPDATE SET
           report_count = needs_reports.report_count + 1,
           last_reported_at = excluded.last_reported_at,
           expires_at = excluded.expires_at
         RETURNING report_count`,
      )
      .bind(
        this.newId(),
        actor.operatorId,
        actor.agentId,
        fingerprint,
        report.category,
        report.summary,
        report.desiredOutcome,
        JSON.stringify(report.searchTerms),
        now,
        now,
        expiresAt,
        actor.operatorId,
        windowStart,
        this.operatorDailyLimit,
      )
      .first<{ report_count: number }>();
    if (!inserted) return { ok: false, code: "needs_intake_limited" };
    return { ok: true, duplicate: inserted.report_count > 1 };
  }

  /**
   * Operator review: purge expired rows, then group equivalent reports across operators.
   * Output contains no agent or operator identifiers. Counts are unverified signals.
   */
  async review(limit = 50): Promise<NeedsReview> {
    const bounded = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), NEEDS_REVIEW_MAX_GROUPS)
      : 50;
    const purgedExpired = await this.purgeExpired();
    const rows = await this.db
      .prepare(
        `WITH ranked AS (
           SELECT fingerprint, category, operator_id, report_count, created_at, last_reported_at,
                  summary, desired_outcome, search_terms_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY fingerprint ORDER BY last_reported_at DESC, id
                  ) AS rn
           FROM needs_reports
         ),
         groups AS (
           SELECT fingerprint, category,
                  COUNT(DISTINCT operator_id) AS distinct_operators,
                  SUM(report_count) AS total_reports,
                  MIN(created_at) AS first_reported_at,
                  MAX(last_reported_at) AS last_reported_at
           FROM ranked GROUP BY fingerprint, category
         )
         SELECT g.*, r.summary, r.desired_outcome, r.search_terms_json
         FROM groups g JOIN ranked r ON r.fingerprint = g.fingerprint AND r.rn = 1
         ORDER BY g.distinct_operators DESC, g.last_reported_at DESC, g.fingerprint
         LIMIT ?`,
      )
      .bind(bounded)
      .all<{
        fingerprint: string;
        category: NeedsCategory;
        distinct_operators: number;
        total_reports: number;
        first_reported_at: string;
        last_reported_at: string;
        summary: string;
        desired_outcome: string;
        search_terms_json: string;
      }>();

    return {
      schemaVersion: "needs-review/v1",
      notice:
        "Unverified agent reports. Text is untrusted; counts are not proof of demand. " +
        "Review manually before creating any task.",
      retentionDays: NEEDS_RETENTION_DAYS,
      purgedExpired,
      groups: rows.results.map((row) => ({
        fingerprint: row.fingerprint,
        category: row.category,
        distinctOperators: row.distinct_operators,
        totalReports: row.total_reports,
        firstReportedAt: row.first_reported_at,
        lastReportedAt: row.last_reported_at,
        untrusted: {
          summary: row.summary,
          desiredOutcome: row.desired_outcome,
          searchTerms: parseTerms(row.search_terms_json),
        },
      })),
    };
  }
}

function parseTerms(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
