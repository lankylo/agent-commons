/**
 * Deterministic search-document text for the internal D1 FTS5 index (no LLM, no ranking).
 *
 * Indexed: title, purpose, content type; Knowledge summary, fact subjects/predicates/scalar values and
 * structured record keys/scalar values. Fact predicates and record keys are indexed as the original
 * identifier plus its camelCase/acronym/digit-separated components; Execution objective, target domains, input/output names and
 * types, and required capabilities.
 *
 * Deliberately NOT indexed: Knowledge `explanation` (untrusted prose), fact units, sources, rights,
 * evidence, licensing, verification claims, steps, contributor/operator/agent identifiers, hashes,
 * timestamps, platform state and raw JSON. Only fields explicitly listed here ever reach the index.
 */
import type { ExecutionContributionInput } from "./execution";
import type { KnowledgeContributionInput, Scalar } from "./knowledge";

/**
 * Splits a structured identifier (camelCase, PascalCase, acronyms, digits, `_ - . : / space`
 * separators) into components, e.g. `successStatus` -> success, Status; `HTTPStatus2xx` -> HTTP,
 * Status, 2, xx. Deterministic; no stemming or synonyms.
 */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((c) => c !== "");
}

/** The original identifier followed by its separated components (only when it has several). */
export function identifierSearchText(id: string): string {
  const parts = splitIdentifier(id);
  return parts.length > 1 || (parts[0] !== undefined && parts[0] !== id)
    ? `${id} ${parts.join(" ")}`
    : id;
}

const scalarText = (v: Scalar): string | undefined => (v === null ? undefined : String(v));

/** One line per field group, in a fixed order; empty parts are dropped. */
export function buildSearchText(
  content: KnowledgeContributionInput | ExecutionContributionInput,
): string {
  const parts: (string | undefined)[] = [content.title, content.purpose, content.contentType];
  if (content.family === "knowledge") {
    parts.push(content.summary);
    for (const f of content.facts ?? []) {
      parts.push(f.subject, identifierSearchText(f.predicate), scalarText(f.value));
    }
    for (const record of content.records ?? []) {
      for (const key of Object.keys(record).sort()) {
        parts.push(identifierSearchText(key), scalarText(record[key] as Scalar));
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
