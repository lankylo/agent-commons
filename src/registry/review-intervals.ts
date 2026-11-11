/**
 * Platform-defined maximum review intervals per content type. Centrally defined,
 * deterministic and not contributor-overridable: contributors may choose a shorter
 * interval, never a longer one. Content types are scoped per family, so the same
 * name in two families would be an independent entry.
 */
import type { ContributionFamily } from "./envelope";

export const MAX_REVIEW_INTERVAL_DAYS = {
  knowledge: {
    "api-reference": 90,
    "api-limits": 30,
    "error-reference": 180,
    "concept-summary": 365,
  },
  execution: {
    "api-recipe": 60,
    "diagnostic-recipe": 90,
  },
} as const satisfies Record<ContributionFamily, Readonly<Record<string, number>>>;

export type KnowledgeContentType = keyof typeof MAX_REVIEW_INTERVAL_DAYS.knowledge;
export type ExecutionContentType = keyof typeof MAX_REVIEW_INTERVAL_DAYS.execution;

/** Platform maximum in days, or undefined when the content type is not defined for the family. */
export function maxReviewIntervalDays(
  family: ContributionFamily,
  contentType: unknown,
): number | undefined {
  if (typeof contentType !== "string") return undefined;
  const table: Readonly<Record<string, number>> = MAX_REVIEW_INTERVAL_DAYS[family];
  return Object.prototype.hasOwnProperty.call(table, contentType) ? table[contentType] : undefined;
}

/** Returns error messages (empty when valid). Both inputs are untrusted. */
export function checkReviewInterval(
  family: ContributionFamily,
  contentType: unknown,
  days: unknown,
): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const max = maxReviewIntervalDays(family, contentType);
  if (max === undefined) {
    errors.push({
      path: "contentType",
      message: `must be one of: ${Object.keys(MAX_REVIEW_INTERVAL_DAYS[family]).join(", ")}`,
    });
  }
  if (days === undefined || days === null) {
    errors.push({ path: "reviewIntervalDays", message: "is required" });
  } else if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
    errors.push({
      path: "reviewIntervalDays",
      message: "must be a positive integer number of days",
    });
  } else if (max !== undefined && days > max) {
    errors.push({
      path: "reviewIntervalDays",
      message: `exceeds the platform maximum of ${max} days for ${family} content type "${String(contentType)}"`,
    });
  }
  return errors;
}
