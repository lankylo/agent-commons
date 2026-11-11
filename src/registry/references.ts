/**
 * Cross-family contribution references (Phase 2). A reference points from a
 * contribution in one family to an exact, immutable version of a contribution
 * in the OPPOSITE family. References are never embedded content, and are never
 * "latest"-style: the version is always explicit. Pure, deterministic and
 * storage-independent: resolution goes through a caller-supplied resolver.
 */
import { CONTRIBUTION_FAMILIES, type ContributionFamily, type ContributionRef } from "./envelope";
import { Checker } from "./check";

export const REFERENCE_KEYS = ["family", "id", "version"] as const;

/** Lowercase alphanumerics and hyphens, 8-64 chars, no leading hyphen (UUIDs fit). */
export const CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function oppositeFamily(family: ContributionFamily): ContributionFamily {
  return family === "knowledge" ? "execution" : "knowledge";
}

export function isContributionIdFormat(v: unknown): v is string {
  return typeof v === "string" && CONTRIBUTION_ID_PATTERN.test(v);
}

/** Versions are positive safe integers. */
export function isContributionVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/**
 * Structural validation of an untrusted `related` array owned by a contribution
 * of `ownFamily`. Records errors on `c`. Does not touch storage.
 */
export function checkContributionRefs(
  c: Checker,
  value: unknown,
  path: string,
  ownFamily: ContributionFamily,
  max: number,
): void {
  const seen = new Set<string>();
  c.list(value, path, max).forEach((r, i) => {
    const p = `${path}[${i}]`;
    const o = c.obj(r, p, REFERENCE_KEYS);
    if (!o) return;
    let valid = true;
    if (!(CONTRIBUTION_FAMILIES as readonly unknown[]).includes(o.family)) {
      c.err(`${p}.family`, `must be one of: ${CONTRIBUTION_FAMILIES.join(", ")}`);
      valid = false;
    } else if (o.family === ownFamily) {
      c.err(`${p}.family`, `must reference the opposite family (${oppositeFamily(ownFamily)})`);
      valid = false;
    }
    if (!isContributionIdFormat(o.id)) {
      c.err(`${p}.id`, "must match the contribution ID format");
      valid = false;
    }
    if (!isContributionVersion(o.version)) {
      c.err(`${p}.version`, "must be a positive integer");
      valid = false;
    }
    if (valid) {
      const key = `${String(o.family)}\u0000${String(o.id)}\u0000${String(o.version)}`;
      if (seen.has(key)) c.err(p, "duplicate reference");
      seen.add(key);
    }
  });
}

/**
 * Answers whether the exact immutable version exists. Must not fall back to a
 * different or latest version. May be sync or async (storage comes later).
 */
export type ContributionVersionResolver = (
  family: ContributionFamily,
  id: string,
  version: number,
) => boolean | Promise<boolean>;

/** Resolver over a supplied set of existing contribution versions. */
export function createVersionSetResolver(
  existing: Iterable<{ family: ContributionFamily; id: string; version: number }>,
): ContributionVersionResolver {
  const keys = new Set<string>();
  for (const e of existing) keys.add(`${e.family}\u0000${e.id}\u0000${e.version}`);
  return (family, id, version) => keys.has(`${family}\u0000${id}\u0000${version}`);
}

export type ReferenceResolution =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Resolve references already accepted by a family validator. Re-checks the
 * structure (so it is safe on its own), then requires every reference to
 * resolve to an exact existing version. Never throws; a throwing resolver or
 * any non-`true` answer counts as unresolved.
 */
export async function resolveContributionRefs(
  ownFamily: ContributionFamily,
  refs: readonly ContributionRef[] | undefined,
  resolver: ContributionVersionResolver,
  path = "related",
): Promise<ReferenceResolution> {
  if (refs === undefined) return { ok: true };
  const c = new Checker();
  checkContributionRefs(c, refs, path, ownFamily, Number.MAX_SAFE_INTEGER);
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  const errors: string[] = [];
  for (const [i, r] of refs.entries()) {
    let found: boolean;
    try {
      found = (await resolver(r.family, r.id, r.version)) === true;
    } catch {
      found = false;
    }
    if (!found) {
      errors.push(
        `${path}[${i}]: does not resolve to an existing ${r.family} contribution version`,
      );
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
