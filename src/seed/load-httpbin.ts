/**
 * Loads the prepared httpbin seed fixtures into the local contribution registry (Phase 2).
 *
 * Narrow by design: it only calls `ContributionRegistry` (exact-hash lookup, creation,
 * retrieval) for an EXISTING active, allow-listed contributor agent. It never creates or
 * changes operators, agents or credentials, makes no network request and exposes no API.
 *
 * Order: Knowledge first, then the Execution fixture built with `executionWithKnowledgeRef`
 * from the exact stored Knowledge ID and version. Each step first looks the validated content
 * hash up (same operator only); an existing record is verified through normal retrieval and
 * reused, so reruns and partial-state resumes write nothing extra.
 *
 * Licence: the owner approved ISC as the contributed-content licence for both seed records.
 * The Execution record is owner-tested only, never independently verified.
 */
import type { AgentId } from "../identity/types";
import { hashContribution } from "../registry/content-hash";
import type { CreationError, ContributionRegistry } from "../registry/creation";
import type { ContributionId } from "../registry/envelope";
import type { RetrievalError } from "../registry/retrieval";
import { HTTPBIN_KNOWLEDGE_SEED, executionWithKnowledgeRef } from "./httpbin";

export interface SeededContribution {
  readonly id: string;
  readonly version: number;
  /** true when this run created it; false when an identical record already existed. */
  readonly created: boolean;
}

export type SeedHttpbinResult =
  | {
      readonly ok: true;
      readonly knowledge: SeededContribution;
      readonly execution: SeededContribution;
    }
  | {
      readonly ok: false;
      readonly step: "knowledge" | "execution";
      readonly error: CreationError | RetrievalError | { code: "invalid_fixture"; message: string };
    };

type StepResult =
  | { ok: true; value: SeededContribution }
  | { ok: false; error: Extract<SeedHttpbinResult, { ok: false }>["error"] };

async function resolveOrCreate(
  registry: ContributionRegistry,
  agentId: AgentId,
  input: unknown,
  family: "knowledge" | "execution",
): Promise<StepResult> {
  const hashed = await hashContribution(input);
  if (!hashed.ok) {
    return {
      ok: false,
      error: { code: "invalid_fixture", message: hashed.errors.join("; ") },
    };
  }
  const lookup = await registry.findVersionByContentHash(agentId, hashed.hash);
  if (!lookup.ok) return { ok: false, error: lookup.error };
  if (lookup.found) {
    // Reuse only after normal retrieval verifies hash, provenance, family and content.
    const got = await registry.getContributionVersion(lookup.found.id, lookup.found.version);
    if (!got.ok) return { ok: false, error: got.error };
    if (got.contribution.family !== family || got.contribution.contentHash !== hashed.hash) {
      return {
        ok: false,
        error: { code: "invalid_fixture", message: "existing record does not match fixture" },
      };
    }
    return {
      ok: true,
      value: { id: lookup.found.id, version: lookup.found.version, created: false },
    };
  }
  const created = await registry.createContribution(agentId, input);
  if (!created.ok) return { ok: false, error: created.error };
  const { id, version } = created.contribution;
  return { ok: true, value: { id, version, created: true } };
}

export async function seedHttpbinContributions(
  registry: ContributionRegistry,
  contributorAgentId: AgentId,
): Promise<SeedHttpbinResult> {
  const knowledge = await resolveOrCreate(
    registry,
    contributorAgentId,
    HTTPBIN_KNOWLEDGE_SEED,
    "knowledge",
  );
  if (!knowledge.ok) return { ok: false, step: "knowledge", error: knowledge.error };

  const execution = await resolveOrCreate(
    registry,
    contributorAgentId,
    executionWithKnowledgeRef({
      family: "knowledge",
      id: knowledge.value.id as ContributionId,
      version: knowledge.value.version,
    }),
    "execution",
  );
  if (!execution.ok) return { ok: false, step: "execution", error: execution.error };
  return { ok: true, knowledge: knowledge.value, execution: execution.value };
}
