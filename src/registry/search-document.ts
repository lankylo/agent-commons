/**
 * Deterministic search-document text for the internal D1 FTS5 index (no LLM, no ranking).
 *
 * Indexed: title, purpose, content type; Knowledge summary, fact subjects/predicates/scalar values and
 * structured record keys/scalar values; Execution objective, target domains, input/output names and
 * types, and required capabilities.
 *
 * Deliberately NOT indexed: Knowledge `explanation` (untrusted prose), fact units, sources, rights,
 * evidence, licensing, verification claims, steps, contributor/operator/agent identifiers, hashes,
 * timestamps, platform state and raw JSON. Only fields explicitly listed here ever reach the index.
 */
import type { ExecutionContributionInput } from "./execution";
import type { KnowledgeContributionInput, Scalar } from "./knowledge";

const scalarText = (v: Scalar): string | undefined => (v === null ? undefined : String(v));

/** One line per field group, in a fixed order; empty parts are dropped. */
export function buildSearchText(
  content: KnowledgeContributionInput | ExecutionContributionInput,
): string {
  const parts: (string | undefined)[] = [content.title, content.purpose, content.contentType];
  if (content.family === "knowledge") {
    parts.push(content.summary);
    for (const f of content.facts ?? []) {
      parts.push(f.subject, f.predicate, scalarText(f.value));
    }
    for (const record of content.records ?? []) {
      for (const key of Object.keys(record).sort()) {
        parts.push(key, scalarText(record[key] as Scalar));
      }
    }
  } else {
    parts.push(content.objective, ...content.targetDomains);
    for (const i of content.inputs) parts.push(i.name, i.type);
    for (const o of content.outputs) parts.push(o.name, o.type);
    parts.push(...content.compatibility.requiredCapabilities);
  }
  return parts.filter((p): p is string => p !== undefined && p !== "").join("\n");
}
