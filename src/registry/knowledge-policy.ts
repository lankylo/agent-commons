import { isObj } from "./check";
import { PERMITTED_USES, type KnowledgeContributionInput } from "./knowledge";

export interface KnowledgePermissionCombination {
  readonly sourceLicense: string;
  readonly permittedUse: (typeof PERMITTED_USES)[number];
  readonly dataPermission: string;
}

export interface KnowledgePermissionPolicy {
  readonly permittedCombinations: readonly KnowledgePermissionCombination[];
}

export type KnowledgePermissionPolicyParseResult =
  | { readonly ok: true; readonly policy: KnowledgePermissionPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

function isNonEmptyDeclaration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function combinationKey(combination: KnowledgePermissionCombination): string {
  return JSON.stringify([
    combination.sourceLicense,
    combination.permittedUse,
    combination.dataPermission,
  ]);
}

/** Parse the platform-owned declarations policy. Contributors never provide this configuration. */
export function parseKnowledgePermissionPolicy(
  value: unknown,
): KnowledgePermissionPolicyParseResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      errors: ["KNOWLEDGE_PERMISSION_POLICY_JSON: must be configured"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return {
      ok: false,
      errors: ["KNOWLEDGE_PERMISSION_POLICY_JSON: must contain valid JSON"],
    };
  }
  if (!isObj(parsed)) {
    return {
      ok: false,
      errors: ["KNOWLEDGE_PERMISSION_POLICY_JSON: must be an object"],
    };
  }

  const errors: string[] = [];
  if (Object.keys(parsed).some((key) => key !== "permittedCombinations")) {
    errors.push("KNOWLEDGE_PERMISSION_POLICY_JSON: only permittedCombinations is supported");
  }

  const combinations: KnowledgePermissionCombination[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(parsed.permittedCombinations) || parsed.permittedCombinations.length === 0) {
    errors.push(
      "KNOWLEDGE_PERMISSION_POLICY_JSON.permittedCombinations: requires at least one rule",
    );
  } else {
    parsed.permittedCombinations.forEach((value, index) => {
      const path = `KNOWLEDGE_PERMISSION_POLICY_JSON.permittedCombinations[${index}]`;
      if (!isObj(value)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (
        Object.keys(value).some(
          (key) => !["sourceLicense", "permittedUse", "dataPermission"].includes(key),
        )
      ) {
        errors.push(`${path}: only sourceLicense, permittedUse, and dataPermission are supported`);
      }
      if (!isNonEmptyDeclaration(value.sourceLicense)) {
        errors.push(`${path}.sourceLicense: must be a non-empty trimmed declaration`);
      }
      if (!(PERMITTED_USES as readonly unknown[]).includes(value.permittedUse)) {
        errors.push(`${path}.permittedUse: must be one of ${PERMITTED_USES.join(", ")}`);
      }
      if (!isNonEmptyDeclaration(value.dataPermission)) {
        errors.push(`${path}.dataPermission: must be a non-empty trimmed declaration`);
      }
      if (
        !isNonEmptyDeclaration(value.sourceLicense) ||
        !(PERMITTED_USES as readonly unknown[]).includes(value.permittedUse) ||
        !isNonEmptyDeclaration(value.dataPermission)
      ) {
        return;
      }

      const combination = {
        sourceLicense: value.sourceLicense,
        permittedUse: value.permittedUse as KnowledgePermissionCombination["permittedUse"],
        dataPermission: value.dataPermission,
      };
      const key = combinationKey(combination);
      if (seen.has(key)) errors.push(`${path}: duplicate permission combination`);
      else {
        seen.add(key);
        combinations.push(combination);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: { permittedCombinations: combinations } };
}

/** Check declarations only; this does not verify ownership or truth of contributor claims. */
export function checkKnowledgePermissionPolicy(
  content: KnowledgeContributionInput,
  policy: KnowledgePermissionPolicy,
): readonly string[] {
  const errors: string[] = [];
  const sourceLicense = content.rights.sourceLicense;
  const permittedUse = content.rights.permittedUse;
  const dataPermission = content.licensing.dataPermission;

  if (content.licensing.license !== sourceLicense) {
    errors.push("rights.sourceLicense: must match licensing.license");
  }

  const key = combinationKey({ sourceLicense, permittedUse, dataPermission });
  if (!policy.permittedCombinations.some((item) => combinationKey(item) === key)) {
    const message = "declaration combination is not permitted by platform policy";
    errors.push(`rights.sourceLicense: ${message}`);
    errors.push(`rights.permittedUse: ${message}`);
    errors.push(`licensing.dataPermission: ${message}`);
  }
  return errors;
}
