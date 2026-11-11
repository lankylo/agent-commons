/**
 * Deterministic content hashing for validated contributions.
 *
 * The hash covers contributor-supplied, validated content only, plus the
 * contribution family. Platform-assigned fields (id, version, contentHash,
 * contributor, timestamps, reliability, consumer count) are always excluded.
 * Uses only Web Crypto and TextEncoder, so it runs on Cloudflare Workers.
 *
 * Canonical form: JSON with object keys sorted by UTF-16 code unit order,
 * no insignificant whitespace, arrays in submitted order, strings as emitted
 * by JSON.stringify (no Unicode normalization). `undefined` object members
 * are omitted; non-finite numbers and non-JSON values are rejected.
 */
import { PLATFORM_ONLY_FIELDS, type ContributionFamily } from "./envelope";
import { validateExecutionContribution } from "./execution";
import { validateKnowledgeContribution } from "./knowledge";

export class CanonicalJsonError extends Error {}

/** Serialize a JSON-compatible value to canonical JSON. Throws CanonicalJsonError. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((v) => {
            if (v === undefined) throw new CanonicalJsonError("undefined array element");
            return canonicalJson(v);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("only plain objects are supported");
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
  }
}

/** The canonical JSON of a validated contribution: platform fields removed, family kept. */
export function canonicalContributionJson(validated: {
  readonly family: ContributionFamily;
}): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(validated)) {
    if ((PLATFORM_ONLY_FIELDS as readonly string[]).includes(k)) continue;
    content[k] = v;
  }
  return canonicalJson(content);
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Hash already-validated contribution content (output of a family validator). */
export function hashValidatedContribution(validated: {
  readonly family: ContributionFamily;
}): Promise<string> {
  return sha256Hex(canonicalContributionJson(validated));
}

export type ContentHashResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate untrusted input with the validator for its declared family, then hash
 * the validated content. Invalid input is never hashed. Never throws.
 */
export async function hashContribution(input: unknown): Promise<ContentHashResult> {
  const family =
    typeof input === "object" && input !== null
      ? (input as { family?: unknown }).family
      : undefined;
  const result =
    family === "knowledge"
      ? validateKnowledgeContribution(input)
      : family === "execution"
        ? validateExecutionContribution(input)
        : ({ ok: false, errors: ['family: must be "knowledge" or "execution"'] } as const);
  if (!result.ok) return { ok: false, errors: result.errors };
  try {
    return { ok: true, hash: await hashValidatedContribution(result.value) };
  } catch (e) {
    if (e instanceof CanonicalJsonError) return { ok: false, errors: [`content: ${e.message}`] };
    throw e;
  }
}
