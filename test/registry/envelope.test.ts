import { describe, expect, it } from "vitest";
import {
  CONTRIBUTION_FAMILIES,
  findPlatformFieldViolations,
  isContributionFamily,
} from "../../src/registry/envelope";

describe("contribution envelope", () => {
  it("accepts only the two defined families", () => {
    expect(CONTRIBUTION_FAMILIES).toEqual(["knowledge", "execution"]);
    expect(isContributionFamily("knowledge")).toBe(true);
    expect(isContributionFamily("execution")).toBe(true);
    for (const bad of ["Knowledge", "recipe", "", undefined, null, 1, {}]) {
      expect(isContributionFamily(bad)).toBe(false);
    }
  });

  it("flags platform-computed fields in contributor input", () => {
    expect(findPlatformFieldViolations({ family: "knowledge", title: "t" })).toEqual([]);
    expect(
      findPlatformFieldViolations({ title: "t", reliabilityScore: 1, consumerCount: 9, id: "x" }),
    ).toEqual(["id", "reliabilityScore", "consumerCount"]);
  });
});
