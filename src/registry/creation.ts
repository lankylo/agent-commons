/**
 * Contribution creation (version 1) and immutable versioning (version n+1, see
 * `createContributionVersion`).
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
import { buildSearchText } from "./search-document";
import {
  checkExecutionDomainPolicy,
  parseExecutionDomainPolicy,
  validateExecutionContribution,
  type ExecutionContributionInput,
  type ExecutionDomainPolicy,
} from "./execution";
import { validateKnowledgeContribution, type KnowledgeContributionInput } from "./knowledge";
import { resolveContributionRefs } from "./references";
import { ContributionRetriever, type RetrieveResult } from "./retrieval";

export type CreationErrorCode =
  | "actor_not_found"
  | "actor_inactive"
  | "operator_not_allow_listed"
  | "execution_domain_policy_unavailable"
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

export type VersionErrorCode =
  | CreationErrorCode
  | "invalid_expected_version"
  | "contribution_not_found"
  | "operator_mismatch"
  | "version_conflict"
  | "family_mismatch";

export interface VersionError extends Omit<CreationError, "code"> {
  readonly code: VersionErrorCode;
  /** Only for version_conflict from a stale expected version. */
  readonly latestVersion?: number;
}

export interface CreatedContributionVersion extends Omit<CreatedContribution, "version"> {
  readonly version: number;
  readonly previousVersion: number;
}

export type CreateVersionResult =
  | { readonly ok: true; readonly contribution: CreatedContributionVersion }
  | { readonly ok: false; readonly error: VersionError };

interface PreparedContent {
  readonly content: KnowledgeContributionInput | ExecutionContributionInput;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
}

export interface RegistryEnv {
  DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  EXECUTION_DOMAIN_POLICY_JSON?: string;
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
const failV = (error: VersionError): CreateVersionResult => ({ ok: false, error });

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
  private readonly executionDomainPolicyJson: string | undefined;

  constructor(env: RegistryEnv, platform: Partial<RegistryPlatform> = {}) {
    this.db = env.DB;
    this.bucket = env.CONTENT_BUCKET;
    this.executionDomainPolicyJson = env.EXECUTION_DOMAIN_POLICY_JSON;
    this.platform = { ...defaultPlatform, ...platform };
  }

  /**
   * Internal, verified retrieval of one exact immutable version (see `retrieval.ts`).
   * No "latest" alias, search, listing or access control.
   */
  getContributionVersion(contributionId: string, version: number): Promise<RetrieveResult> {
    return new ContributionRetriever({
      DB: this.db,
      CONTENT_BUCKET: this.bucket,
    }).getContributionVersion(contributionId, version);
  }

  /**
   * Internal exact content-hash lookup (no search, no listing). The agent must be active and
   * allow-listed, and only versions owned by the agent's own operator are returned.
   */
  async findVersionByContentHash(
    agentId: AgentId,
    contentHash: string,
  ): Promise<
    | { ok: true; found: { id: string; version: number; family: ContributionFamily } | null }
    | { ok: false; error: CreationError }
  > {
    const actor = await this.resolveActor(agentId);
    if (!actor.ok) return { ok: false, error: actor.error };
    const hit = await this.db
      .prepare(
        `SELECT v.contribution_id AS id, v.version AS version, v.family AS family
           FROM contribution_versions v JOIN contributions c ON c.id = v.contribution_id
          WHERE v.content_hash = ? AND c.contributor_operator_id = ?`,
      )
      .bind(contentHash, actor.contributor.operatorId)
      .first<{ id: string; version: number; family: ContributionFamily }>();
    return { ok: true, found: hit ?? null };
  }

  /** Create version 1 of a new contribution on behalf of an authenticated agent. */
  async createContribution(agentId: AgentId, input: unknown): Promise<CreateContributionResult> {
    const actor = await this.resolveActor(agentId);
    if (!actor.ok) return fail(actor.error);
    const contributor = actor.contributor;

    const prepared = await this.prepareContent(input, contributor.operatorId);
    // family_mismatch / version codes cannot occur without a required family or version.
    if (!prepared.ok) return fail(prepared.error as CreationError);

    // Platform-assigned identity and timestamps.
    const id = this.platform.newContributionId();
    const createdAt = this.platform.now().toISOString();

    const stored = await this.storeContent(prepared.value);
    if (!stored.ok) return fail(stored.error);

    const { content, contentHash, bytes } = prepared.value;
    // D1 second: one atomic batch. A failure here leaves only a harmless orphan object.
    const statements = [
      this.db
        .prepare(
          "INSERT INTO contributions (id, family, contributor_agent_id, contributor_operator_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id, content.family, contributor.agentId, contributor.operatorId, createdAt),
      ...this.buildStatements({
        id,
        version: 1,
        createdAt,
        contributor,
        contentHash,
        payloadBytes: bytes.byteLength,
        content,
      }),
    ];
    const failure = await this.commit(statements, contentHash, contributor.operatorId);
    if (failure) return fail(failure as CreationError);

    return {
      ok: true,
      contribution: {
        id,
        version: 1,
        family: content.family,
        contentHash,
        contentKey: stored.key,
        payloadBytes: bytes.byteLength,
        contributor,
        createdAt,
      },
    };
  }

  /**
   * Create the next immutable version of an existing contribution.
   *
   * The author must be an active agent of the contribution's ORIGINAL operator, and that operator
   * must still be allow-listed. The contribution id and family never change; the new version is
   * `expectedPreviousVersion + 1` and is accepted only if that is still the latest version
   * (optimistic concurrency; a racing writer loses on the (contribution_id, version) primary key
   * inside the atomic batch). Input is validated, hashed and written exactly as in creation:
   * R2 first, then one D1 batch. Earlier versions, their rows and R2 objects are never touched.
   */
  async createContributionVersion(
    agentId: AgentId,
    contributionId: string,
    expectedPreviousVersion: number,
    input: unknown,
  ): Promise<CreateVersionResult> {
    const actor = await this.resolveActor(agentId);
    if (!actor.ok) return failV(actor.error);
    const contributor = actor.contributor;

    if (!Number.isSafeInteger(expectedPreviousVersion) || expectedPreviousVersion < 1) {
      return failV({
        code: "invalid_expected_version",
        message: "expectedPreviousVersion must be a positive integer",
      });
    }

    const head = await this.db
      .prepare(
        `SELECT c.family AS family, c.contributor_operator_id AS operator_id,
                (SELECT MAX(version) FROM contribution_versions WHERE contribution_id = c.id) AS latest
           FROM contributions c WHERE c.id = ?`,
      )
      .bind(contributionId)
      .first<{ family: ContributionFamily; operator_id: string; latest: number | null }>();
    if (!head || head.latest === null) {
      return failV({ code: "contribution_not_found", message: "contribution not found" });
    }
    if (head.operator_id !== contributor.operatorId) {
      return failV({
        code: "operator_mismatch",
        message: "only the contribution's original operator may create new versions",
      });
    }
    if (head.latest !== expectedPreviousVersion) {
      return failV({
        code: "version_conflict",
        message: "expected previous version is not the latest version",
        latestVersion: head.latest,
      });
    }

    const prepared = await this.prepareContent(input, contributor.operatorId, head.family);
    if (!prepared.ok) return failV(prepared.error);

    const version = expectedPreviousVersion + 1;
    const createdAt = this.platform.now().toISOString();
    const stored = await this.storeContent(prepared.value);
    if (!stored.ok) return failV(stored.error);

    const { content, contentHash, bytes } = prepared.value;
    const failure = await this.commit(
      this.buildStatements({
        id: contributionId,
        version,
        createdAt,
        contributor,
        contentHash,
        payloadBytes: bytes.byteLength,
        content,
      }),
      contentHash,
      contributor.operatorId,
      true,
    );
    if (failure) return failV(failure);

    return {
      ok: true,
      contribution: {
        id: contributionId,
        version,
        previousVersion: expectedPreviousVersion,
        family: content.family,
        contentHash,
        contentKey: stored.key,
        payloadBytes: bytes.byteLength,
        contributor,
        createdAt,
      },
    };
  }

  /** Active agent + active operator + allow-listed operator. */
  private async resolveActor(
    agentId: AgentId,
  ): Promise<{ ok: true; contributor: ActorRef } | { ok: false; error: CreationError }> {
    const row = await this.db
      .prepare(
        `SELECT a.status AS agent_status, o.id AS operator_id, o.status AS operator_status,
                o.contribution_allow_listed AS allow_listed
           FROM agents a JOIN operators o ON o.id = a.operator_id WHERE a.id = ?`,
      )
      .bind(agentId)
      .first<AgentOperatorRow>();
    if (!row) return { ok: false, error: { code: "actor_not_found", message: "agent not found" } };
    if (row.agent_status !== "active" || row.operator_status !== "active") {
      return {
        ok: false,
        error: { code: "actor_inactive", message: "agent or operator is not active" },
      };
    }
    if (row.allow_listed !== 1) {
      return {
        ok: false,
        error: {
          code: "operator_not_allow_listed",
          message: "operator is not allow-listed to contribute",
        },
      };
    }
    return { ok: true, contributor: { agentId, operatorId: row.operator_id as OperatorId } };
  }

  /** Shared by creation and versioning: platform fields, validation, references, hash, duplicates. */
  private async prepareContent(
    input: unknown,
    operatorId: OperatorId,
    requiredFamily?: ContributionFamily,
  ): Promise<{ ok: true; value: PreparedContent } | { ok: false; error: VersionError }> {
    const bad = (error: VersionError) => ({ ok: false, error }) as const;

    // Platform-only fields are rejected before any validation.
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const violations = findPlatformFieldViolations(input as Record<string, unknown>);
      if (violations.length > 0) {
        return bad({
          code: "platform_field_rejected",
          message: "platform-computed fields cannot be set by contributors",
          errors: violations.map((k) => `${k}: platform-computed field cannot be set`),
        });
      }
    }

    // Family validator.
    const family = (input as { family?: unknown } | null | undefined)?.family;
    if (requiredFamily !== undefined && family !== requiredFamily) {
      return bad({
        code: "family_mismatch",
        message: `a ${requiredFamily} contribution cannot change family`,
      });
    }
    let executionDomainPolicy: ExecutionDomainPolicy | undefined;
    if (family === "execution") {
      const policy = parseExecutionDomainPolicy(this.executionDomainPolicyJson);
      if (!policy.ok) {
        return bad({
          code: "execution_domain_policy_unavailable",
          message: "Execution domain policy is missing or invalid.",
          errors: policy.errors,
        });
      }
      executionDomainPolicy = policy.policy;
    }

    const validated =
      family === "knowledge"
        ? validateKnowledgeContribution(input)
        : family === "execution"
          ? validateExecutionContribution(input)
          : ({ ok: false, errors: ['family: must be "knowledge" or "execution"'] } as const);
    if (!validated.ok) {
      return bad({
        code: "invalid_content",
        message: "content failed validation",
        errors: validated.errors,
      });
    }
    const content = validated.value;

    if (content.family === "execution") {
      if (executionDomainPolicy === undefined) {
        return bad({
          code: "execution_domain_policy_unavailable",
          message: "Execution domain policy is missing or invalid.",
        });
      }
      const policyErrors = checkExecutionDomainPolicy(content, executionDomainPolicy);
      if (policyErrors.length > 0) {
        return bad({
          code: "invalid_content",
          message: "content failed platform Execution domain policy",
          errors: policyErrors,
        });
      }
    }

    // Cross-family references must resolve to exact stored versions.
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
      return bad({
        code: "unresolved_reference",
        message: "one or more references do not resolve",
        errors: refs.errors,
      });
    }

    // Canonical JSON and hash.
    let canonical: string;
    try {
      canonical = canonicalJson(content);
    } catch (e) {
      if (e instanceof CanonicalJsonError) {
        return bad({
          code: "invalid_content",
          message: "content cannot be canonicalized",
          errors: [`content: ${e.message}`],
        });
      }
      throw e;
    }
    const bytes = new TextEncoder().encode(canonical);
    const contentHash = await sha256Hex(canonical);

    // Duplicate content (before any write).
    const dup = await this.findDuplicate(contentHash, operatorId);
    if (dup) return bad(dup);

    return { ok: true, value: { content, bytes, contentHash } };
  }

  /** R2 first: immutable, content-addressed, idempotent. */
  private async storeContent(
    p: PreparedContent,
  ): Promise<{ ok: true; key: string } | { ok: false; error: CreationError }> {
    try {
      const { key } = await putContentObject(this.bucket, {
        family: p.content.family,
        contentType: p.content.contentType,
        bytes: p.bytes,
      });
      return { ok: true, key };
    } catch {
      return {
        ok: false,
        error: { code: "storage_failed", message: "content object could not be stored" },
      };
    }
  }

  /** One atomic D1 batch; maps hash and version-key races to typed errors. */
  private async commit(
    statements: D1PreparedStatement[],
    contentHash: string,
    operatorId: OperatorId,
    versioning = false,
  ): Promise<VersionError | undefined> {
    try {
      await this.db.batch(statements);
      return undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/UNIQUE constraint failed: contribution_versions\.content_hash/.test(msg)) {
        const raced = await this.findDuplicate(contentHash, operatorId);
        return raced ?? { code: "duplicate_content", message: "identical content already exists" };
      }
      if (
        versioning &&
        /UNIQUE constraint failed: contribution_versions\.contribution_id, contribution_versions\.version/.test(
          msg,
        )
      ) {
        return {
          code: "version_conflict",
          message: "a concurrent update created this version first",
        };
      }
      return {
        code: "persistence_failed",
        message: versioning ? "version could not be saved" : "contribution could not be saved",
      };
    }
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
    version: number;
    createdAt: string;
    contributor: ActorRef;
    contentHash: string;
    payloadBytes: number;
    content: KnowledgeContributionInput | ExecutionContributionInput;
  }): D1PreparedStatement[] {
    const { id, version, createdAt, contributor, contentHash, content } = p;
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const s: D1PreparedStatement[] = [
      q(
        `INSERT INTO contribution_versions (contribution_id, version, previous_version, family,
           author_agent_id, author_operator_id, content_hash, hash_algorithm, payload_bytes, title,
           purpose, content_type, license, data_permission, review_interval_days, as_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        version,
        version === 1 ? null : version - 1,
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
        "INSERT INTO version_platform_state (contribution_id, version, last_verified_at, reliability_score, consumer_count, updated_at) VALUES (?, ?, NULL, NULL, 0, ?)",
        id,
        version,
        createdAt,
      ),
    ];
    content.evidence.forEach((e, i) =>
      s.push(
        q(
          "INSERT INTO contribution_evidence (contribution_id, version, ordinal, kind, uri) VALUES (?, ?, ?, ?, ?)",
          id,
          version,
          i,
          e.kind,
          e.uri,
        ),
      ),
    );
    (content.related ?? []).forEach((r, i) =>
      s.push(
        q(
          "INSERT INTO contribution_references (from_contribution_id, from_version, from_family, ordinal, to_contribution_id, to_version, to_family) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          version,
          content.family,
          i,
          r.id,
          r.version,
          r.family,
        ),
      ),
    );
    // Same atomic batch: the immutable search document (the FTS5 index is filled by a trigger).
    s.push(
      q(
        "INSERT INTO contribution_search_documents (contribution_id, version, family, content_type, indexed_text) VALUES (?, ?, ?, ?, ?)",
        id,
        version,
        content.family,
        content.contentType,
        buildSearchText(content),
      ),
    );
    if (content.family === "knowledge") s.push(...this.knowledgeStatements(id, version, content));
    else s.push(...this.executionStatements(id, version, content));
    return s;
  }

  private knowledgeStatements(
    id: string,
    version: number,
    k: KnowledgeContributionInput,
  ): D1PreparedStatement[] {
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const s: D1PreparedStatement[] = [
      q(
        `INSERT INTO knowledge_versions (contribution_id, version, family, summary, explanation, records_json,
           source_license, rights_holder, permitted_use, verification_method, declared_confidence)
         VALUES (?, ?, 'knowledge', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        version,
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
          "INSERT INTO knowledge_facts (contribution_id, version, ordinal, subject, predicate, value_json, unit) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          version,
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
             hash_algorithm, hash_digest, snapshot_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          version,
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

  private executionStatements(
    id: string,
    version: number,
    x: ExecutionContributionInput,
  ): D1PreparedStatement[] {
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).bind(...args);
    const verification = x.verification;
    const s: D1PreparedStatement[] = [
      q(
        `INSERT INTO execution_versions (contribution_id, version, family, objective, inputs_json, outputs_json,
           steps_json, success_checks_json, compatibility_json, side_effect, requires_human_approval,
           max_requests, timeout_seconds, on_failure, verification_method, tested_at, declared_confidence)
         VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        version,
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
          "INSERT INTO execution_target_domains (contribution_id, version, domain) VALUES (?, ?, ?)",
          id,
          version,
          domain,
        ),
      );
    }
    return s;
  }
}
