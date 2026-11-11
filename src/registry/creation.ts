/**
 * Initial contribution creation (version 1 only).
 *
 * Accepts an already-authenticated agent id plus untrusted Knowledge or Execution input
 * (HTTP authentication is a separate task). The service resolves the active agent and its
 * operator, requires the operator's contribution allow-list flag, rejects platform-only
 * fields, runs the family validator, resolves every cross-family reference to an exact
 * stored version, builds canonical JSON and its SHA-256 hash, then assigns the contribution
 * id, version 1, contributor identity and timestamps. Callers can never choose those.
 *
 * WRITE ORDER (deliberate): R2 first, then one D1 batch.
 *   1. The immutable canonical bytes are written to R2 at the content-addressed key
 *      `contributions/sha256/<hash>` (write-once; identical bytes are a no-op).
 *   2. Only then are the contribution, version 1, platform state and family rows written in a
 *      single D1 batch (one transaction: all rows or none).
 * D1 therefore never references a missing R2 object. If the D1 batch fails after step 1, the
 * R2 object is an orphan. That is harmless: the key is derived from the content, nothing in D1
 * points at it, it exposes nothing that is served, and a retry of the same content reuses it
 * (`created: false`) instead of conflicting. Orphans are never deleted by this module.
 * The duplicate-hash lookup runs before any R2 write so rejected duplicates write nothing;
 * `UNIQUE (content_hash)` remains the race-safe backstop and maps to `duplicate_content`.
 */
import type { ActorRef, AgentId, OperatorId } from "../identity/types";
import { putContentObject } from "../storage/content-objects";
import { canonicalJson, CanonicalJsonError, sha256Hex } from "./content-hash";
import { findPlatformFieldViolations, type ContributionFamily } from "./envelope";
import { validateExecutionContribution, type ExecutionContributionInput } from "./execution";
import { validateKnowledgeContribution, type KnowledgeContributionInput } from "./knowledge";
import { resolveContributionRefs } from "./references";

export type CreationErrorCode =
  | "actor_not_found"
  | "actor_inactive"
  | "operator_not_allow_listed"
  | "platform_field_rejected"
  | "invalid_content"
  | "unresolved_reference"
  | "duplicate_content"
  | "storage_failed"
  | "persistence_failed";

export interface CreationError {
  readonly code: CreationErrorCode;
  readonly message: string;
  /** Field-level problems for validation, platform-field and reference failures. */
  readonly errors?: readonly string[];
  /** Only for duplicate_content, and only when the duplicate belongs to the same operator. */
  readonly existing?: { readonly contributionId: string; readonly version: number };
}

export interface CreatedContribution {
  readonly id: string;
  readonly version: 1;
  readonly family: ContributionFamily;
  readonly contentHash: string;
  readonly contentKey: string;
  readonly payloadBytes: number;
  readonly contributor: ActorRef;
  readonly createdAt: string;
}

export type CreateContributionResult =
  | { readonly ok: true; readonly contribution: CreatedContribution }
  | { readonly ok: false; readonly error: CreationError };

export interface RegistryEnv {
  DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
}

/** Platform-supplied sources, injectable for tests only. */
export interface RegistryPlatform {
  readonly now: () => Date;
  readonly newContributionId: () => string;
}

const defaultPlatform: RegistryPlatform = {
  now: () => new Date(),
  newContributionId: () => crypto.randomUUID(),
};

const fail = (error: CreationError): CreateContributionResult => ({ ok: false, error });

interface AgentOperatorRow {
  agent_status: string;
  operator_id: string;
  operator_status: string;
  allow_listed: number;
}

export class ContributionRegistry {
  private readonly db: D1Database;
  private readonly bucket: R2Bucket;
  private readonly platform: RegistryPlatform;

  constructor(env: RegistryEnv, platform: Partial<RegistryPlatform> = {}) {
    this.db = env.DB;
    this.bucket = env.CONTENT_BUCKET;
    this.platform = { ...defaultPlatform, ...platform };
  }

  /** Create version 1 of a new contribution on behalf of an authenticated agent. */
  async createContribution(agentId: AgentId, input: unknown): Promise<CreateContributionResult> {
    // 1. Actor: active agent, active operator, allow-listed operator.
    const row = await this.db
      .prepare(
        `SELECT a.status AS agent_status, o.id AS operator_id, o.status AS operator_status,
                o.contribution_allow_listed AS allow_listed
           FROM agents a JOIN operators o ON o.id = a.operator_id WHERE a.id = ?`,
      )
      .bind(agentId)
      .first<AgentOperatorRow>();
    if (!row) return fail({ code: "actor_not_found", message: "agent not found" });
    if (row.agent_status !== "active" || row.operator_status !== "active") {
      return fail({ code: "actor_inactive", message: "agent or operator is not active" });
    }
    if (row.allow_listed !== 1) {
      return fail({
        code: "operator_not_allow_listed",
        message: "operator is not allow-listed to contribute",
      });
    }
    const contributor: ActorRef = { agentId, operatorId: row.operator_id as OperatorId };

    // 2. Platform-only fields are rejected before any validation.
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const violations = findPlatformFieldViolations(input as Record<string, unknown>);
      if (violations.length > 0) {
        return fail({
          code: "platform_field_rejected",
          message: "platform-computed fields cannot be set by contributors",
          errors: violations.map((k) => `${k}: platform-computed field cannot be set`),
        });
      }
    }

    // 3. Family validator.
    const family = (input as { family?: unknown } | null | undefined)?.family;
    const validated =
      family === "knowledge"
        ? validateKnowledgeContribution(input)
        : family === "execution"
          ? validateExecutionContribution(input)
          : ({ ok: false, errors: ['family: must be "knowledge" or "execution"'] } as const);
    if (!validated.ok) {
      return fail({
        code: "invalid_content",
        message: "content failed validation",
        errors: validated.errors,
      });
    }
    const content = validated.value;

    // 4. Cross-family references must resolve to exact stored versions.
    const refs = await resolveContributionRefs(
      content.family,
      content.related,
      async (f, id, version) =>
        (await this.db
          .prepare(
            "SELECT 1 AS found FROM contribution_versions WHERE contribution_id = ? AND version = ? AND family = ?",
          )
          .bind(id, version, f)
          .first()) !== null,
    );
    if (!refs.ok) {
      return fail({
        code: "unresolved_reference",
        message: "one or more references do not resolve",
        errors: refs.errors,
      });
    }

    // 5. Canonical JSON and hash.
    let canonical: string;
    try {
      canonical = canonicalJson(content);
    } catch (e) {
      if (e instanceof CanonicalJsonError) {
        return fail({
          code: "invalid_content",
          message: "content cannot be canonicalized",
          errors: [`content: ${e.message}`],
        });
      }
      throw e;
    }
    const bytes = new TextEncoder().encode(canonical);
    const contentHash = await sha256Hex(canonical);

    // 6. Duplicate content (before any write).
    const dup = await this.findDuplicate(contentHash, contributor.operatorId);
    if (dup) return fail(dup);

    // 7. Platform-assigned identity and timestamps.
    const id = this.platform.newContributionId();
    const createdAt = this.platform.now().toISOString();

    // 8. R2 first: immutable, content-addressed, idempotent.
    let contentKey: string;
    try {
      contentKey = (
        await putContentObject(this.bucket, {
          family: content.family,
          contentType: content.contentType,
          bytes,
        })
      ).key;
    } catch {
      return fail({ code: "storage_failed", message: "content object could not be stored" });
    }

    // 9. D1 second: one atomic batch. A failure here leaves only a harmless orphan object.
    const statements = this.buildStatements({
      id,
      createdAt,
      contributor,
      contentHash,
      payloadBytes: bytes.byteLength,
      content,
    });
    try {
      await this.db.batch(statements);
    } catch (e) {
      if (
        e instanceof Error &&
        /UNIQUE constraint failed: contribution_versions\.content_hash/.test(e.message)
      ) {
        const raced = await this.findDuplicate(contentHash, contributor.operatorId);
        return fail(
          raced ?? { code: "duplicate_content", message: "identical content already exists" },
        );
      }
      return fail({ code: "persistence_failed", message: "contribution could not be saved" });
    }

    return {
      ok: true,
      contribution: {
        id,
        version: 1,
        family: content.family,
        contentHash,
        contentKey,
        payloadBytes: bytes.byteLength,
        contributor,
        createdAt,
      },
    };
  }

  private async findDuplicate(
    contentHash: string,
    operatorId: OperatorId,
  ): Promise<CreationError | undefined> {
    const hit = await this.db
      .prepare(
        `SELECT v.contribution_id AS id, v.version AS version, c.contributor_operator_id AS operator_id
           FROM contribution_versions v JOIN contributions c ON c.id = v.contribution_id
          WHERE v.content_hash = ?`,
      )
      .bind(contentHash)
      .first<{ id: string; version: number; operator_id: string }>();
    if (!hit) return undefined;
    const base = {
      code: "duplicate_content",
      message: "identical content already exists",
    } as const;
    return hit.operator_id === operatorId
      ? { ...base, existing: { contributionId: hit.id, version: hit.version } }
      : base;
  }

  private buildStatements(p: {
    id: string;
    createdAt: string;
    contributor: ActorRef;
    contentHash: string;
    payloadBytes: number;
    content: KnowledgeContributionInput | ExecutionContributionInput;
  }): D1PreparedStatement[] {
    const { id, createdAt, contributor, contentHash, content } = p;
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const s: D1PreparedStatement[] = [
      q(
        "INSERT INTO contributions (id, family, contributor_agent_id, contributor_operator_id, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        content.family,
        contributor.agentId,
        contributor.operatorId,
        createdAt,
      ),
      q(
        `INSERT INTO contribution_versions (contribution_id, version, previous_version, family,
           author_agent_id, author_operator_id, content_hash, hash_algorithm, payload_bytes, title,
           purpose, content_type, license, data_permission, review_interval_days, as_of, created_at)
         VALUES (?, 1, NULL, ?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        content.family,
        contributor.agentId,
        contributor.operatorId,
        contentHash,
        p.payloadBytes,
        content.title,
        content.purpose,
        content.contentType,
        content.licensing.license,
        content.licensing.dataPermission,
        content.reviewIntervalDays,
        content.asOf,
        createdAt,
      ),
      q(
        "INSERT INTO version_platform_state (contribution_id, version, last_verified_at, reliability_score, consumer_count, updated_at) VALUES (?, 1, NULL, NULL, 0, ?)",
        id,
        createdAt,
      ),
    ];
    content.evidence.forEach((e, i) =>
      s.push(
        q(
          "INSERT INTO contribution_evidence (contribution_id, version, ordinal, kind, uri) VALUES (?, 1, ?, ?, ?)",
          id,
          i,
          e.kind,
          e.uri,
        ),
      ),
    );
    (content.related ?? []).forEach((r, i) =>
      s.push(
        q(
          "INSERT INTO contribution_references (from_contribution_id, from_version, from_family, ordinal, to_contribution_id, to_version, to_family) VALUES (?, 1, ?, ?, ?, ?, ?)",
          id,
          content.family,
          i,
          r.id,
          r.version,
          r.family,
        ),
      ),
    );
    if (content.family === "knowledge") s.push(...this.knowledgeStatements(id, content));
    else s.push(...this.executionStatements(id, content));
    return s;
  }

  private knowledgeStatements(id: string, k: KnowledgeContributionInput): D1PreparedStatement[] {
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const s: D1PreparedStatement[] = [
      q(
        `INSERT INTO knowledge_versions (contribution_id, version, family, summary, explanation, records_json,
           source_license, rights_holder, permitted_use, verification_method, declared_confidence)
         VALUES (?, 1, 'knowledge', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        k.summary ?? null,
        k.explanation ?? null,
        k.records === undefined ? null : canonicalJson(k.records),
        k.rights.sourceLicense,
        k.rights.rightsHolder ?? null,
        k.rights.permittedUse,
        k.verification.method,
        k.verification.declaredConfidence ?? null,
      ),
    ];
    (k.facts ?? []).forEach((f, i) =>
      s.push(
        q(
          "INSERT INTO knowledge_facts (contribution_id, version, ordinal, subject, predicate, value_json, unit) VALUES (?, 1, ?, ?, ?, ?, ?)",
          id,
          i,
          f.subject,
          f.predicate,
          canonicalJson(f.value),
          f.unit ?? null,
        ),
      ),
    );
    k.sources.forEach((src, i) =>
      s.push(
        q(
          `INSERT INTO knowledge_sources (contribution_id, version, ordinal, uri, accessed_at, source_date,
             hash_algorithm, hash_digest, snapshot_ref) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          i,
          src.uri,
          src.accessedAt,
          src.sourceDate ?? null,
          src.hash.algorithm,
          src.hash.digest,
          src.snapshotRef ?? null,
        ),
      ),
    );
    return s;
  }

  private executionStatements(id: string, x: ExecutionContributionInput): D1PreparedStatement[] {
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const verification = x.verification;
    const s: D1PreparedStatement[] = [
      q(
        `INSERT INTO execution_versions (contribution_id, version, family, objective, inputs_json, outputs_json,
           steps_json, success_checks_json, compatibility_json, side_effect, requires_human_approval,
           max_requests, timeout_seconds, on_failure, verification_method, tested_at, declared_confidence)
         VALUES (?, 1, 'execution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        x.objective,
        canonicalJson(x.inputs),
        canonicalJson(x.outputs),
        canonicalJson(x.steps),
        canonicalJson(x.successChecks),
        canonicalJson(x.compatibility),
        x.safety.sideEffect,
        x.safety.requiresHumanApproval ? 1 : 0,
        x.safety.maxRequests,
        x.safety.timeoutSeconds,
        x.safety.onFailure,
        verification.method,
        verification.testedAt ?? null,
        verification.declaredConfidence ?? null,
      ),
    ];
    for (const domain of x.targetDomains) {
      s.push(
        q(
          "INSERT INTO execution_target_domains (contribution_id, version, domain) VALUES (?, 1, ?)",
          id,
          domain,
        ),
      );
    }
    return s;
  }
}
