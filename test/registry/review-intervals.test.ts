import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_INTERVAL_DAYS,
  checkReviewInterval,
  maxReviewIntervalDays,
} from "../../src/registry/review-intervals";
import type { ContributionFamily } from "../../src/registry/envelope";

const families = Object.keys(MAX_REVIEW_INTERVAL_DAYS) as ContributionFamily[];
const cases = families.flatMap((f) =>
  Object.entries(MAX_REVIEW_INTERVAL_DAYS[f]).map(([t, max]) => [f, t, max] as const),
);

describe("platform maximum review intervals", () => {
  it("defines the expected content types and maxima", () => {
    expect(MAX_REVIEW_INTERVAL_DAYS).toEqual({
      knowledge: {
        "api-reference": 90,
        "api-limits": 30,
        "error-reference": 180,
        "concept-summary": 365,
      },
      execution: { "api-recipe": 60, "diagnostic-recipe": 90 },
    });
  });

  it.each(cases)("%s/%s: accepts 1, max-1 and exactly max (%i)", (f, t, max) => {
    for (const d of [1, max - 1, max]) expect(checkReviewInterval(f, t, d)).toEqual([]);
  });

  it.each(cases)("%s/%s: rejects max+1 and far above max", (f, t, max) => {
    for (const d of [max + 1, max * 10, Number.MAX_SAFE_INTEGER]) {
      const errs = checkReviewInterval(f, t, d);
      expect(errs).toHaveLength(1);
      expect(errs[0]?.path).toBe("reviewIntervalDays");
      expect(errs[0]?.message).toContain(`${max} days`);
    }
  });

  it.each(cases)("%s/%s: rejects missing, non-positive and invalid values", (f, t) => {
    for (const d of [undefined, null, 0, -1, 1.5, NaN, Infinity, "30", [], {}, true]) {
      expect(checkReviewInterval(f, t, d).length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown, wrong-family, inherited-key and non-string content types", () => {
    for (const [f, t] of [
      ["knowledge", "api-recipe"],
      ["execution", "api-reference"],
      ["knowledge", "unknown"],
      ["execution", "__proto__"],
      ["execution", "constructor"],
      ["knowledge", "toString"],
      ["knowledge", undefined],
      ["knowledge", 5],
    ] as const) {
      expect(maxReviewIntervalDays(f, t)).toBeUndefined();
      expect(checkReviewInterval(f, t, 1).some((e) => e.path === "contentType")).toBe(true);
    }
  });

  it("does not let input alter the platform maxima", () => {
    checkReviewInterval("knowledge", "api-reference", 9999);
    expect(maxReviewIntervalDays("knowledge", "api-reference")).toBe(90);
  });
});
