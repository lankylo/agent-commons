import { describe, expect, it } from "vitest";
import {
  checkContributionRefs,
  createVersionSetResolver,
  oppositeFamily,
  resolveContributionRefs,
} from "../../src/registry/references";
import { Checker } from "../../src/registry/check";
import { validateKnowledgeContribution } from "../../src/registry/knowledge";
import { validateExecutionContribution } from "../../src/registry/execution";
import type { ContributionFamily, ContributionRef } from "../../src/registry/envelope";

const ref = (family: ContributionFamily, id: string, version: number) =>
  ({ family, id, version }) as unknown as ContributionRef;

const errs = (family: ContributionFamily, value: unknown, max = 20): string[] => {
  const c = new Checker();
  checkContributionRefs(c, value, "related", family, max);
  return c.errors;
};

const existing = [
  { family: "knowledge" as const, id: "know-0001", version: 1 },
  { family: "knowledge" as const, id: "know-0001", version: 2 },
  { family: "execution" as const, id: "exec-0001", version: 3 },
];

describe("structural reference validation", () => {
  it("accepts execution -> knowledge and knowledge -> execution", () => {
    expect(errs("execution", [{ family: "knowledge", id: "know-0001", version: 1 }])).toEqual([]);
    expect(errs("knowledge", [{ family: "execution", id: "exec-0001", version: 3 }])).toEqual([]);
  });

  it("rejects same-family references in both families", () => {
    expect(errs("knowledge", [{ family: "knowledge", id: "know-0001", version: 1 }])).toHaveLength(
      1,
    );
    expect(errs("execution", [{ family: "execution", id: "exec-0001", version: 1 }])).toHaveLength(
      1,
    );
  });

  it("rejects missing or unknown family", () => {
    expect(errs("knowledge", [{ id: "exec-0001", version: 1 }])).not.toEqual([]);
    expect(errs("knowledge", [{ family: "other", id: "exec-0001", version: 1 }])).not.toEqual([]);
  });

  it.each(["", "short", "UPPERCASE-ID", "-leading-hyphen", "has space!", "a".repeat(65), 42, null])(
    "rejects malformed id %j",
    (id) => {
      expect(errs("knowledge", [{ family: "execution", id, version: 1 }])).not.toEqual([]);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined])(
    "rejects malformed version %j",
    (version) => {
      expect(errs("knowledge", [{ family: "execution", id: "exec-0001", version }])).not.toEqual(
        [],
      );
    },
  );

  it("rejects exact duplicates but allows different versions of the same contribution", () => {
    const a = { family: "execution", id: "exec-0001", version: 1 };
    expect(errs("knowledge", [a, { ...a }]).join()).toContain("duplicate");
    expect(errs("knowledge", [a, { ...a, version: 2 }])).toEqual([]);
  });

  it("rejects unknown fields (including embedded content)", () => {
    const r = { family: "execution", id: "exec-0001", version: 1, steps: [] };
    expect(errs("knowledge", [r]).join()).toContain("unknown field");
  });

  it("rejects non-array values, non-object entries and too many entries", () => {
    expect(errs("knowledge", "x")).not.toEqual([]);
    expect(errs("knowledge", ["x"])).not.toEqual([]);
    expect(errs("knowledge", [null])).not.toEqual([]);
    const many = [1, 2, 3].map((version) => ({ family: "execution", id: "exec-0001", version }));
    expect(errs("knowledge", many, 2)).not.toEqual([]);
  });

  it("oppositeFamily flips the family", () => {
    expect(oppositeFamily("knowledge")).toBe("execution");
    expect(oppositeFamily("execution")).toBe("knowledge");
  });
});

describe("resolveContributionRefs", () => {
  const resolver = createVersionSetResolver(existing);

  it("resolves exact existing versions in both directions", async () => {
    expect(
      await resolveContributionRefs("execution", [ref("knowledge", "know-0001", 2)], resolver),
    ).toEqual({ ok: true });
    expect(
      await resolveContributionRefs("knowledge", [ref("execution", "exec-0001", 3)], resolver),
    ).toEqual({ ok: true });
  });

  it("treats absent references as resolved", async () => {
    expect(await resolveContributionRefs("knowledge", undefined, resolver)).toEqual({ ok: true });
  });

  it("requires the exact version (no latest or nearest fallback)", async () => {
    const r = await resolveContributionRefs(
      "execution",
      [ref("knowledge", "know-0001", 3)],
      resolver,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown IDs and wrong-family lookups", async () => {
    expect(
      (await resolveContributionRefs("execution", [ref("knowledge", "know-9999", 1)], resolver)).ok,
    ).toBe(false);
    // exec-0001 exists only as execution; a knowledge-family lookup must not match it.
    expect(
      (await resolveContributionRefs("execution", [ref("knowledge", "exec-0001", 3)], resolver)).ok,
    ).toBe(false);
  });

  it("reports every unresolved reference by index", async () => {
    const r = await resolveContributionRefs(
      "execution",
      [
        ref("knowledge", "know-0001", 1),
        ref("knowledge", "know-0001", 9),
        ref("knowledge", "know-8888", 1),
      ],
      resolver,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.slice(0, 10))).toEqual(["related[1]", "related[2]"]);
  });

  it("rejects structurally invalid references without calling the resolver", async () => {
    let calls = 0;
    const counting = () => (calls++, true);
    const same = await resolveContributionRefs(
      "execution",
      [ref("execution", "exec-0001", 1)],
      counting,
    );
    const dup = await resolveContributionRefs(
      "execution",
      [ref("knowledge", "know-0001", 1), ref("knowledge", "know-0001", 1)],
      counting,
    );
    expect(same.ok).toBe(false);
    expect(dup.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("supports async resolvers and treats throws or non-true answers as unresolved", async () => {
    const asyncOk = async () => true;
    expect(
      (await resolveContributionRefs("execution", [ref("knowledge", "know-0001", 1)], asyncOk)).ok,
    ).toBe(true);
    const thrower = () => {
      throw new Error("boom");
    };
    expect(
      (await resolveContributionRefs("execution", [ref("knowledge", "know-0001", 1)], thrower)).ok,
    ).toBe(false);
    const truthy = (() => "yes") as unknown as () => boolean;
    expect(
      (await resolveContributionRefs("execution", [ref("knowledge", "know-0001", 1)], truthy)).ok,
    ).toBe(false);
  });
});

describe("family schemas integrate references without sharing payloads", () => {
  it("both validators reject same-family and unknown-field references", () => {
    const k = validateKnowledgeContribution({
      family: "knowledge",
      related: [{ family: "knowledge", id: "know-0001", version: 1 }],
    });
    const e = validateExecutionContribution({
      family: "execution",
      related: [{ family: "execution", id: "exec-0001", version: 1, x: 1 }],
    });
    expect(k.ok === false && k.errors.some((m) => m.startsWith("related[0].family"))).toBe(true);
    expect(e.ok === false && e.errors.some((m) => m.startsWith("related[0].family"))).toBe(true);
    expect(e.ok === false && e.errors.some((m) => m.startsWith("related[0].x"))).toBe(true);
  });
});
