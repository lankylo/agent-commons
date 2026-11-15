import { QualityReviewer } from "../../src/registry/quality-review";
import type { RegistryEnv } from "../../src/registry/creation";

/** Test helper: list an exact version through the private reviewer path (pending -> listed). */
export async function listVersion(
  env: RegistryEnv,
  contributionId: string,
  version = 1,
): Promise<void> {
  const r = await new QualityReviewer(env, "test-reviewer").decide(
    contributionId,
    version,
    "listed_unverified",
    "test fixture",
  );
  if (!r.ok) throw new Error(`failed to list fixture: ${r.error.code}`);
}
