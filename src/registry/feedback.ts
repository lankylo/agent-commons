import type { AgentId, OperatorId } from "../identity/types";
import { ContributionRetriever, type RetrievedContribution } from "./retrieval";
import { ISO_UTC, isObj } from "./check";

export const MAX_FEEDBACK_ASSESSMENT_BYTES = 16_000;

const KNOWLEDGE_DIMENSIONS = ["accuracy", "usefulness", "staleness"] as const;
const EXECUTION_DIMENSIONS = ["outcome", "compatibility"] as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type KnowledgeDimension = (typeof KNOWLEDGE_DIMENSIONS)[number];
type ExecutionDimension = (typeof EXECUTION_DIMENSIONS)[number];
type FeedbackDimension = KnowledgeDimension | ExecutionDimension;

interface FeedbackDimensionValue {
  readonly dimension: FeedbackDimension;
  readonly value: Record<string, unknown>;
}

export interface FeedbackActor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
}

export interface FeedbackRegistryEnv {
  readonly DB: D1Database;
  readonly CONTENT_BUCKET: R2Bucket;
}

export type FeedbackSubmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        "feedback_not_eligible" | "feedback_conflict" | "invalid_feedback" | "content_unavailable";
    };

function hasOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return isObj(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isNonEmptyString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARS.test(value)
  );
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function isEvidenceArray(value: unknown, requiresEvidence: boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length > 20 || (requiresEvidence && value.length === 0)) {
    return false;
  }
  return value.every((reference) => {
    if (!hasOnlyKeys(reference, ["kind", "uri"]) || !isNonEmptyString(reference.kind, 200)) {
      return false;
    }
    if (
      typeof reference.uri !== "string" ||
      reference.uri.length === 0 ||
      reference.uri.length > 2048 ||
      CONTROL_CHARS.test(reference.uri)
    ) {
      return false;
    }
    try {
      const uri = new URL(reference.uri);
      return uri.protocol === "https:" && uri.hostname.length > 0 && !uri.username && !uri.password;
    } catch {
      return false;
    }
  });
}

function validateKnowledgeDimension(
  dimension: KnowledgeDimension,
  value: unknown,
): value is Record<string, unknown> {
  if (!isObj(value)) return false;

  switch (dimension) {
    case "accuracy":
      return (
        hasOnlyKeys(value, ["finding", "scope", "evidence"]) &&
        ["accurate", "inaccurate", "mixed", "unable_to_assess"].includes(String(value.finding)) &&
        isNonEmptyString(value.scope, 300) &&
        isEvidenceArray(value.evidence, value.finding !== "unable_to_assess") &&
        (value.finding !== "unable_to_assess" || value.evidence.length === 0)
      );
    case "usefulness":
      return (
        hasOnlyKeys(value, ["finding", "context", "evidence"]) &&
        ["useful", "not_useful", "not_used"].includes(String(value.finding)) &&
        isNonEmptyString(value.context, 300) &&
        isEvidenceArray(value.evidence, value.finding !== "not_used") &&
        (value.finding !== "not_used" || value.evidence.length === 0)
      );
    case "staleness":
      return (
        hasOnlyKeys(value, ["finding", "observedAt", "evidence"]) &&
        ["appears_current", "appears_stale", "not_checked"].includes(String(value.finding)) &&
        isUtcTimestamp(value.observedAt) &&
        isEvidenceArray(value.evidence, value.finding !== "not_checked") &&
        (value.finding !== "not_checked" || value.evidence.length === 0)
      );
  }
}

function validateExecutionOutcome(
  contribution: Extract<RetrievedContribution, { family: "execution" }>,
  value: unknown,
): value is Record<string, unknown> {
  if (
    !hasOnlyKeys(value, ["finding", "observedAt", "steps"]) ||
    !isUtcTimestamp(value.observedAt) ||
    !Array.isArray(value.steps) ||
    value.steps.length > 50
  ) {
    return false;
  }

  const finding = value.finding;
  if (!["success", "failure", "partial", "not_run"].includes(String(finding))) return false;
  if (finding === "not_run") return value.steps.length === 0;
  if (value.steps.length !== contribution.content.steps.length) return false;

  const results: string[] = [];
  for (const [index, rawStep] of value.steps.entries()) {
    const storedStep = contribution.content.steps[index];
    if (
      !storedStep ||
      !hasOnlyKeys(rawStep, ["stepId", "result", "httpStatus"]) ||
      rawStep.stepId !== storedStep.id ||
      !["passed", "failed", "skipped"].includes(String(rawStep.result))
    ) {
      return false;
    }
    if (Object.hasOwn(rawStep, "httpStatus")) {
      if (
        storedStep.type !== "http_request" ||
        typeof rawStep.httpStatus !== "number" ||
        !Number.isInteger(rawStep.httpStatus) ||
        rawStep.httpStatus < 100 ||
        rawStep.httpStatus > 599
      ) {
        return false;
      }
    }
    results.push(String(rawStep.result));
  }

  const passed = results.filter((result) => result === "passed").length;
  const failed = results.filter((result) => result === "failed").length;
  const skipped = results.filter((result) => result === "skipped").length;
  if (finding === "success") return passed === results.length;
  if (finding === "failure") return failed > 0;
  return passed > 0 && skipped > 0 && failed === 0;
}

function validateExecutionCompatibility(
  contribution: Extract<RetrievedContribution, { family: "execution" }>,
  value: unknown,
): value is Record<string, unknown> {
  if (
    !hasOnlyKeys(value, ["finding", "observedAt", "capabilities", "targetVersions"]) ||
    !isUtcTimestamp(value.observedAt) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 20 ||
    !Array.isArray(value.targetVersions) ||
    value.targetVersions.length > 10
  ) {
    return false;
  }

  const finding = value.finding;
  if (
    !["compatible", "incompatible", "partially_tested", "not_tested"].includes(String(finding)) ||
    value.capabilities.length !== contribution.content.compatibility.requiredCapabilities.length
  ) {
    return false;
  }
  const targetVersions = contribution.content.compatibility.targetVersions ?? [];
  if (value.targetVersions.length !== targetVersions.length) return false;

  const results: string[] = [];
  for (const [index, rawCapability] of value.capabilities.entries()) {
    const expected = contribution.content.compatibility.requiredCapabilities[index];
    if (
      expected === undefined ||
      !hasOnlyKeys(rawCapability, ["name", "result"]) ||
      rawCapability.name !== expected ||
      !["available", "unavailable", "not_checked"].includes(String(rawCapability.result))
    ) {
      return false;
    }
    results.push(String(rawCapability.result));
  }
  for (const [index, rawTarget] of value.targetVersions.entries()) {
    const expected = targetVersions[index];
    if (
      expected === undefined ||
      !hasOnlyKeys(rawTarget, ["domain", "result"]) ||
      rawTarget.domain !== expected.domain ||
      !["matched", "mismatched", "not_checked"].includes(String(rawTarget.result))
    ) {
      return false;
    }
    results.push(String(rawTarget.result));
  }

  const hasMismatch = results.some((result) => result === "unavailable" || result === "mismatched");
  const hasUnchecked = results.includes("not_checked");
  const hasChecked = results.some((result) => result === "available" || result === "matched");
  if (finding === "compatible") return !hasMismatch && !hasUnchecked;
  if (finding === "incompatible") return hasMismatch;
  if (finding === "partially_tested") return !hasMismatch && hasChecked && hasUnchecked;
  return results.every((result) => result === "not_checked");
}

function validateAssessment(
  contribution: RetrievedContribution,
  input: unknown,
):
  | { readonly ok: true; readonly dimensions: readonly FeedbackDimensionValue[] }
  | { readonly ok: false } {
  const allowed = contribution.family === "knowledge" ? KNOWLEDGE_DIMENSIONS : EXECUTION_DIMENSIONS;
  if (!hasOnlyKeys(input, allowed) || Object.keys(input).length === 0) {
    return { ok: false };
  }

  const dimensions: FeedbackDimensionValue[] = [];
  if (contribution.family === "knowledge") {
    for (const dimension of KNOWLEDGE_DIMENSIONS) {
      if (!Object.hasOwn(input, dimension)) continue;
      const value = input[dimension];
      if (!validateKnowledgeDimension(dimension, value)) return { ok: false };
      dimensions.push({ dimension, value });
    }
  } else {
    for (const dimension of EXECUTION_DIMENSIONS) {
      if (!Object.hasOwn(input, dimension)) continue;
      const value = input[dimension];
      if (dimension === "outcome") {
        if (!validateExecutionOutcome(contribution, value)) return { ok: false };
        dimensions.push({ dimension, value });
      } else {
        if (!validateExecutionCompatibility(contribution, value)) return { ok: false };
        dimensions.push({ dimension, value });
      }
    }
  }

  if (
    contribution.family === "knowledge" &&
    dimensions.reduce(
      (total, { value }) => total + (Array.isArray(value.evidence) ? value.evidence.length : 0),
      0,
    ) > 20
  ) {
    return { ok: false };
  }

  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_FEEDBACK_ASSESSMENT_BYTES) {
    return { ok: false };
  }
  return { ok: true, dimensions };
}

export class FeedbackRegistry {
  constructor(private readonly env: FeedbackRegistryEnv) {}

  async submit(
    actor: FeedbackActor,
    contributionId: string,
    version: number,
    assessment: unknown,
  ): Promise<FeedbackSubmitResult> {
    const eligibility = await this.env.DB.prepare(
      `SELECT c.contributor_operator_id
         FROM retrieval_receipts r
         JOIN contributions c ON c.id = r.contribution_id
         JOIN contribution_versions v
           ON v.contribution_id = r.contribution_id AND v.version = r.version
        WHERE r.agent_id = ? AND r.contribution_id = ? AND r.version = ?`,
    )
      .bind(actor.agentId, contributionId, version)
      .first<{ contributor_operator_id: string }>();
    if (!eligibility || eligibility.contributor_operator_id === actor.operatorId) {
      return { ok: false, code: "feedback_not_eligible" };
    }

    const retrieved = await new ContributionRetriever(this.env).getContributionVersion(
      contributionId,
      version,
    );
    if (!retrieved.ok) {
      return retrieved.error.code === "contribution_not_found" ||
        retrieved.error.code === "version_not_found"
        ? { ok: false, code: "feedback_not_eligible" }
        : { ok: false, code: "content_unavailable" };
    }

    const validated = validateAssessment(retrieved.contribution, assessment);
    if (!validated.ok) return { ok: false, code: "invalid_feedback" };

    const rows = validated.dimensions.map(({ dimension, value }) => ({
      dimension,
      assessmentJson: JSON.stringify(value),
    }));
    const incomingRows = rows
      .map(() => "SELECT ? AS dimension, ? AS assessment_json")
      .join(" UNION ALL ");
    const dimensionPlaceholders = rows.map(() => "?").join(", ");
    const result = await this.env.DB.prepare(
      `INSERT INTO feedback_reports (
         consumer_operator_id, agent_id, contribution_id, version, dimension, assessment_json
       )
       SELECT ?, ?, ?, ?, incoming.dimension, incoming.assessment_json
         FROM (${incomingRows}) AS incoming
        WHERE NOT EXISTS (
          SELECT 1
            FROM feedback_reports existing
           WHERE existing.consumer_operator_id = ?
             AND existing.contribution_id = ?
             AND existing.version = ?
             AND existing.dimension IN (${dimensionPlaceholders})
             AND existing.agent_id <> ?
        )
       ON CONFLICT (consumer_operator_id, contribution_id, version, dimension)
       DO UPDATE SET assessment_json = excluded.assessment_json
         WHERE feedback_reports.agent_id = excluded.agent_id
       RETURNING dimension`,
    )
      .bind(
        actor.operatorId,
        actor.agentId,
        contributionId,
        version,
        ...rows.flatMap(({ dimension, assessmentJson }) => [dimension, assessmentJson]),
        actor.operatorId,
        contributionId,
        version,
        ...rows.map(({ dimension }) => dimension),
        actor.agentId,
      )
      .all<{ dimension: string }>();
    if (result.results.length !== rows.length) return { ok: false, code: "feedback_conflict" };
    return { ok: true };
  }
}
