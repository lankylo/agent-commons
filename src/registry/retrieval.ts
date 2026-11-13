/**
 * Internal contribution retrieval by immutable contribution ID and exact version.
 *
 * Internal only: no search, listing, "latest" alias, paid-access enforcement or HTTP surface.
 * Loads identity, the requested version, platform state, evidence, references and the family
 * rows from D1, then reads the canonical content object from R2 by the STORED hash and verifies,
 * on every read: object exists; bytes hash to the stored hash; R2 family/content-type/sha256
 * metadata match D1; canonical JSON parses and is byte-identical when re-canonicalized; the
 * family validator accepts it; and the content agrees with the D1 rows.
 *
 * Errors carry a code and a generic message only. Which check failed is deliberately not
 * exposed, so a future public layer can map codes without leaking internals.
 */
import type { ActorRef, AgentId, OperatorId } from "../identity/types";
import { CONTENT_HTTP_TYPE, contentObjectKey, sha256OfBytes } from "../storage/content-objects";
import { canonicalJson } from "./content-hash";
import type { ContributionFamily, ContributionRef } from "./envelope";
import { isContributionFamily } from "./envelope";
import { validateExecutionContribution, type ExecutionContributionInput } from "./execution";
import { validateKnowledgeContribution, type KnowledgeContributionInput } from "./knowledge";
import type { RegistryEnv } from "./creation";

export type RetrievalErrorCode =
  | "invalid_request"
  | "contribution_not_found"
  | "version_not_found"
  | "content_missing"
  | "content_corrupted"
  | "metadata_inconsistent";

export interface RetrievalError {
  readonly code: RetrievalErrorCode;
  readonly message: string;
}

export interface VersionPlatformState {
  readonly lastVerifiedAt: string | null;
  readonly reliabilityScore: number | null;
  readonly consumerCount: number;
  readonly updatedAt: string;
}

interface RetrievedBase {
  readonly id: string;
  readonly version: number;
  readonly previousVersion: number | null;
  readonly contentHash: string;
  readonly payloadBytes: number;
  /** Agent/operator that authored this version. */
  readonly author: ActorRef;
  /** Agent/operator that created the contribution (version 1). */
  readonly contributor: ActorRef;
  readonly contributionCreatedAt: string;
  readonly createdAt: string;
  readonly platformState: VersionPlatformState;
  /** Exact cross-family references of this version, in stored order; empty when none. */
  readonly related: readonly ContributionRef[];
}

export type RetrievedContribution =
  | (RetrievedBase & { readonly family: "knowledge"; readonly content: KnowledgeContributionInput })
  | (RetrievedBase & {
      readonly family: "execution";
      readonly content: ExecutionContributionInput;
    });

export type RetrieveResult =
  | { readonly ok: true; readonly contribution: RetrievedContribution }
  | { readonly ok: false; readonly error: RetrievalError };

const MESSAGES: Record<RetrievalErrorCode, string> = {
  invalid_request: "invalid contribution id or version",
  contribution_not_found: "contribution not found",
  version_not_found: "contribution version not found",
  content_missing: "contribution content is unavailable",
  content_corrupted: "contribution content failed integrity verification",
  metadata_inconsistent: "contribution metadata failed integrity verification",
};
const fail = (code: RetrievalErrorCode): RetrieveResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

interface VersionRow {
  family: string;
  contributor_agent_id: string;
  contributor_operator_id: string;
  contribution_created_at: string;
  previous_version: number | null;
  author_agent_id: string;
  author_operator_id: string;
  content_hash: string;
  hash_algorithm: string;
  payload_bytes: number;
  title: string;
  purpose: string;
  content_type: string;
  license: string;
  data_permission: string;
  review_interval_days: number;
  as_of: string;
  created_at: string;
  last_verified_at: string | null;
  reliability_score: number | null;
  consumer_count: number | null;
  state_updated_at: string | null;
}

export class ContributionRetriever {
  private readonly db: D1Database;
  private readonly bucket: R2Bucket;

  constructor(env: RegistryEnv) {
    this.db = env.DB;
    this.bucket = env.CONTENT_BUCKET;
  }

  /** Retrieve exactly `version` of contribution `contributionId`, fully verified. */
  async getContributionVersion(contributionId: string, version: number): Promise<RetrieveResult> {
    if (
      typeof contributionId !== "string" ||
      contributionId.length === 0 ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      return fail("invalid_request");
    }

    const head = await this.db
      .prepare("SELECT 1 AS found FROM contributions WHERE id = ?")
      .bind(contributionId)
      .first();
    if (!head) return fail("contribution_not_found");

    const row = await this.db
      .prepare(
        `SELECT c.family AS family, c.contributor_agent_id, c.contributor_operator_id,
                c.created_at AS contribution_created_at,
                v.previous_version, v.author_agent_id, v.author_operator_id, v.content_hash,
                v.hash_algorithm, v.payload_bytes, v.title, v.purpose, v.content_type, v.license,
                v.data_permission, v.review_interval_days, v.as_of, v.created_at,
                s.last_verified_at, s.reliability_score, s.consumer_count,
                s.updated_at AS state_updated_at
           FROM contributions c
           JOIN contribution_versions v ON v.contribution_id = c.id
           LEFT JOIN version_platform_state s
             ON s.contribution_id = v.contribution_id AND s.version = v.version
          WHERE c.id = ? AND v.version = ?`,
      )
      .bind(contributionId, version)
      .first<VersionRow>();
    if (!row) return fail("version_not_found");

    const [evidence, refs, familyRow] = await Promise.all([
      this.db
        .prepare(
          "SELECT kind, uri FROM contribution_evidence WHERE contribution_id = ? AND version = ? ORDER BY ordinal",
        )
        .bind(contributionId, version)
        .all<{ kind: string; uri: string }>(),
      this.db
        .prepare(
          `SELECT to_family, to_contribution_id, to_version FROM contribution_references
            WHERE from_contribution_id = ? AND from_version = ? ORDER BY ordinal`,
        )
        .bind(contributionId, version)
        .all<{ to_family: string; to_contribution_id: string; to_version: number }>(),
      this.loadFamilyRow(row.family, contributionId, version),
    ]);

    // D1 internal consistency.
    if (
      !isContributionFamily(row.family) ||
      row.hash_algorithm !== "sha256" ||
      row.consumer_count === null ||
      row.state_updated_at === null ||
      familyRow === null
    ) {
      return fail("metadata_inconsistent");
    }
    const family: ContributionFamily = row.family;

    // R2 object.
    let key: string;
    try {
      key = contentObjectKey(row.content_hash);
    } catch {
      return fail("metadata_inconsistent");
    }
    let obj: R2ObjectBody | null;
    let bytes: Uint8Array;
    try {
      obj = await this.bucket.get(key);
      if (!obj) return fail("content_missing");
      bytes = new Uint8Array(await obj.arrayBuffer());
    } catch {
      return fail("content_missing");
    }

    // Integrity of the bytes.
    if (
      (await sha256OfBytes(bytes)) !== row.content_hash ||
      bytes.byteLength !== row.payload_bytes
    ) {
      return fail("content_corrupted");
    }

    // R2 metadata must agree with D1.
    const custom = obj.customMetadata;
    if (
      obj.httpMetadata?.contentType !== CONTENT_HTTP_TYPE ||
      custom?.["family"] !== family ||
      custom?.["contentType"] !== row.content_type ||
      custom?.["sha256"] !== row.content_hash
    ) {
      return fail("metadata_inconsistent");
    }

    // Canonical JSON, then the family validator.
    let parsed: unknown;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      parsed = JSON.parse(text);
    } catch {
      return fail("content_corrupted");
    }
    const validated =
      family === "knowledge"
        ? validateKnowledgeContribution(parsed)
        : validateExecutionContribution(parsed);
    if (!validated.ok) return fail("content_corrupted");
    try {
      if (canonicalJson(validated.value) !== text) return fail("content_corrupted");
    } catch {
      return fail("content_corrupted");
    }
    const content = validated.value;

    // Content must agree with D1 identity and envelope rows.
    const sameEvidence =
      content.evidence.length === evidence.results.length &&
      content.evidence.every(
        (e, i) => e.kind === evidence.results[i]?.kind && e.uri === evidence.results[i]?.uri,
      );
    const related = content.related ?? [];
    const sameRefs =
      related.length === refs.results.length &&
      related.every((r, i) => {
        const d = refs.results[i];
        return (
          d?.to_family === r.family && d.to_contribution_id === r.id && d.to_version === r.version
        );
      });
    if (
      content.family !== family ||
      content.contentType !== row.content_type ||
      content.title !== row.title ||
      content.purpose !== row.purpose ||
      content.licensing.license !== row.license ||
      content.licensing.dataPermission !== row.data_permission ||
      content.reviewIntervalDays !== row.review_interval_days ||
      content.asOf !== row.as_of ||
      !sameEvidence ||
      !sameRefs
    ) {
      return fail("metadata_inconsistent");
    }

    // Built from the integrity-checked D1 rows (verified identical to the canonical content).
    const relatedList: ContributionRef[] = refs.results.map((d) => ({
      family: d.to_family as ContributionRef["family"],
      id: d.to_contribution_id as ContributionRef["id"],
      version: d.to_version,
    }));
    const base: RetrievedBase = {
      id: contributionId,
      version,
      previousVersion: row.previous_version,
      contentHash: row.content_hash,
      payloadBytes: row.payload_bytes,
      author: {
        agentId: row.author_agent_id as AgentId,
        operatorId: row.author_operator_id as OperatorId,
      },
      contributor: {
        agentId: row.contributor_agent_id as AgentId,
        operatorId: row.contributor_operator_id as OperatorId,
      },
      contributionCreatedAt: row.contribution_created_at,
      createdAt: row.created_at,
      platformState: {
        lastVerifiedAt: row.last_verified_at,
        reliabilityScore: row.reliability_score,
        consumerCount: row.consumer_count,
        updatedAt: row.state_updated_at,
      },
      related: relatedList,
    };
    return content.family === "knowledge"
      ? { ok: true, contribution: deepFreeze({ ...base, family: "knowledge", content }) }
      : { ok: true, contribution: deepFreeze({ ...base, family: "execution", content }) };
  }

  /** The family extension row for this version, or null when absent/wrong family. */
  private async loadFamilyRow(
    family: string,
    id: string,
    version: number,
  ): Promise<Record<string, unknown> | null> {
    const table =
      family === "knowledge"
        ? "knowledge_versions"
        : family === "execution"
          ? "execution_versions"
          : null;
    if (table === null) return null;
    return await this.db
      .prepare(`SELECT * FROM ${table} WHERE contribution_id = ? AND version = ?`)
      .bind(id, version)
      .first<Record<string, unknown>>();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
