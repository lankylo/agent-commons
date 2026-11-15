import { describe, expect, it } from "vitest";
import { HTTPBIN_KNOWLEDGE_SEED } from "../../src/seed/httpbin";
import type { KnowledgeContributionInput } from "../../src/registry/knowledge";
import {
  checkKnowledgePermissionPolicy,
  parseKnowledgePermissionPolicy,
} from "../../src/registry/knowledge-policy";

const permittedCombinations = [
  {
    sourceLicense: "ISC",
    permittedUse: "redistribute",
    dataPermission: "redistribution-allowed",
  },
  {
    sourceLicense: "CC-BY-4.0",
    permittedUse: "summary",
    dataPermission: "redistribution-allowed",
  },
];

const policy = parseKnowledgePermissionPolicy(JSON.stringify({ permittedCombinations }));

describe("Knowledge permission policy", () => {
  it("accepts explicitly permitted, matching declarations", () => {
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error("expected valid test policy");
    expect(checkKnowledgePermissionPolicy(HTTPBIN_KNOWLEDGE_SEED, policy.policy)).toEqual([]);
  });

  it("rejects missing, invalid, empty, unsupported and duplicate policy configuration", () => {
    expect(parseKnowledgePermissionPolicy(undefined)).toMatchObject({
      ok: false,
      errors: ["KNOWLEDGE_PERMISSION_POLICY_JSON: must be configured"],
    });
    expect(parseKnowledgePermissionPolicy("{")).toMatchObject({ ok: false });
    expect(parseKnowledgePermissionPolicy('{"permittedCombinations":[]}')).toMatchObject({
      ok: false,
    });
    expect(
      parseKnowledgePermissionPolicy(
        JSON.stringify({
          permittedCombinations: [
            {
              sourceLicense: "ISC",
              permittedUse: "unlimited",
              dataPermission: "redistribution-allowed",
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseKnowledgePermissionPolicy(JSON.stringify({ permittedCombinations, override: true })),
    ).toMatchObject({ ok: false });
    expect(
      parseKnowledgePermissionPolicy(
        JSON.stringify({
          permittedCombinations: [permittedCombinations[0], permittedCombinations[0]],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects unsupported and contradictory contributor declarations by field", () => {
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error("expected valid test policy");

    const unsupported: KnowledgeContributionInput = {
      ...HTTPBIN_KNOWLEDGE_SEED,
      rights: { ...HTTPBIN_KNOWLEDGE_SEED.rights, permittedUse: "summary" },
    };
    expect(checkKnowledgePermissionPolicy(unsupported, policy.policy)).toEqual(
      expect.arrayContaining([
        "rights.sourceLicense: declaration combination is not permitted by platform policy",
        "rights.permittedUse: declaration combination is not permitted by platform policy",
        "licensing.dataPermission: declaration combination is not permitted by platform policy",
      ]),
    );

    const contradictory: KnowledgeContributionInput = {
      ...HTTPBIN_KNOWLEDGE_SEED,
      licensing: { ...HTTPBIN_KNOWLEDGE_SEED.licensing, license: "CC-BY-4.0" },
    };
    expect(checkKnowledgePermissionPolicy(contradictory, policy.policy)).toContain(
      "rights.sourceLicense: must match licensing.license",
    );
  });
});
