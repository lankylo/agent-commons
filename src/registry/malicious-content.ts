/**
 * Deterministic malicious-content checks of validated contribution content (Phase 5).
 *
 * Runs on the already-validated Knowledge or Execution value in the shared registry path, after
 * secret/personal-data scanning and before reference resolution, hashing or any D1/R2 write, so
 * REST, MCP, creation and versioning share one result. Every string value and object key in either
 * family is checked with the phrase detectors in `malicious-patterns.ts`. Execution recipes also get
 * a structural check: a URL inside a step value or an input's allowed values must point at one of
 * the recipe's declared `targetDomains` (exact host or label-boundary subdomain), so a literal
 * cannot smuggle an undeclared destination (for example a redirect or callback parameter).
 *
 * Nothing is executed or fetched; no LLM is used. Findings report the field path and category only.
 * Work is bounded like secret scanning and exceeding a bound fails closed.
 */
import { safeFieldPath } from "./content-scan";
import { detectMaliciousText, type MaliciousCategory } from "./malicious-patterns";

export const MALICIOUS_SCAN_LIMITS = {
  maxDepth: 16,
  maxNodes: 50_000,
  maxTotalChars: 2_000_000,
  maxReportedFindings: 20,
} as const;

export type MaliciousContentCategory = MaliciousCategory | "undeclared_target";

export interface MaliciousContentFinding {
  readonly path: string;
  readonly category: MaliciousContentCategory;
}

export type MaliciousContentResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly findings: readonly MaliciousContentFinding[];
      /** Safe, value-free messages suitable for API error details. */
      readonly errors: readonly string[];
    };

const LABELS: Record<MaliciousContentCategory, string> = {
  instruction_override: "instruction to override a consuming agent's rules",
  prompt_delimiter: "chat-role or prompt delimiter marker",
  credential_disclosure: "request to disclose credentials or private data",
  unauthorized_tool_use: "instruction to invoke tools or act without authorization",
  boundary_bypass: "attempt to bypass declared targets or approval boundaries",
  hidden_characters: "hidden bidirectional or tag control characters",
  undeclared_target: "URL outside the recipe's declared target domains",
};

/** `scheme://host` or protocol-relative `//host`, optionally with userinfo. Bounded. */
const URL_HOST =
  /(?:^|[^A-Za-z0-9+.-])(?:[A-Za-z][A-Za-z0-9+.-]{0,31}:)?\/\/(?:[^\s/?#@]{0,256}@)?(\[[^\]\s]{0,64}\]|[^\s/?#:@]{1,253})/g;

function isDeclaredHost(host: string, targets: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return targets.some((t) => h === t || h.endsWith(`.${t}`));
}

/** True when the string contains a URL whose host is not a declared target. Exported for tests. */
export function hasUndeclaredUrl(text: string, targets: readonly string[]): boolean {
  if (!text.includes("//")) return false;
  for (const match of text.matchAll(URL_HOST)) {
    if (!isDeclaredHost(match[1]!, targets)) return true;
  }
  return false;
}

/** Execution subtrees whose values flow into requests and so must stay within declared targets. */
const EXECUTION_URL_CHECKED_ROOTS = new Set(["steps", "inputs"]);

class LimitExceeded extends Error {}

/** Check a validated contribution value. Never returns or logs any checked value. */
export function scanMaliciousContent(value: unknown): MaliciousContentResult {
  const findings: MaliciousContentFinding[] = [];
  let nodes = 0;
  let chars = 0;

  const root =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const targets =
    root.family === "execution" && Array.isArray(root.targetDomains)
      ? root.targetDomains
          .filter((d): d is string => typeof d === "string")
          .map((d) => d.toLowerCase().replace(/\.$/, ""))
      : null;

  const record = (path: string, categories: readonly MaliciousContentCategory[]) => {
    for (const category of categories) findings.push({ path, category });
  };
  const charge = (length: number) => {
    nodes += 1;
    chars += length;
    if (nodes > MALICIOUS_SCAN_LIMITS.maxNodes || chars > MALICIOUS_SCAN_LIMITS.maxTotalChars) {
      throw new LimitExceeded();
    }
  };

  const visit = (node: unknown, path: string, depth: number, checkUrls: boolean): void => {
    if (depth > MALICIOUS_SCAN_LIMITS.maxDepth) throw new LimitExceeded();
    if (typeof node === "string") {
      charge(node.length);
      record(path, detectMaliciousText(node));
      if (checkUrls && targets !== null && hasUndeclaredUrl(node, targets)) {
        record(path, ["undeclared_target"]);
      }
    } else if (Array.isArray(node)) {
      charge(0);
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, checkUrls));
    } else if (node !== null && typeof node === "object") {
      charge(0);
      Object.keys(node).forEach((key, index) => {
        charge(key.length);
        // safeFieldPath redacts keys that trigger a detector, so flagged keys are never echoed.
        const childPath = safeFieldPath(path, key, index);
        const keyFindings = detectMaliciousText(key);
        if (keyFindings.length > 0) record(`${childPath} (field name)`, keyFindings);
        const childCheckUrls = checkUrls || (depth === 0 && EXECUTION_URL_CHECKED_ROOTS.has(key));
        visit((node as Record<string, unknown>)[key], childPath, depth + 1, childCheckUrls);
      });
    } else {
      charge(0);
    }
  };

  try {
    visit(value, "", 0, false);
  } catch (error) {
    if (!(error instanceof LimitExceeded)) throw error;
    return {
      ok: false,
      findings: [],
      errors: ["content: exceeds the malicious-content checking limits"],
    };
  }

  if (findings.length === 0) return { ok: true };
  const reported = findings.slice(0, MALICIOUS_SCAN_LIMITS.maxReportedFindings);
  const errors = reported.map(
    (f) =>
      `${f.path || "content"}: matches a malicious-content check (${LABELS[f.category]}); remove or rephrase it`,
  );
  if (findings.length > reported.length) {
    errors.push(`content: ${findings.length - reported.length} additional findings not shown`);
  }
  return { ok: false, findings: reported, errors };
}
