/**
 * Execution contribution schema (Phase 2). Validates untrusted contributor
 * input for the `execution` family within the shared envelope. Pure and
 * deterministic: no I/O, no storage, no LLM, and nothing here executes a step.
 *
 * An Execution recipe is inspectable data, not a permission grant. There is no
 * free-text command field anywhere: every string is an enum member, a
 * constrained identifier, a hostname, a path or a whitespace-free literal.
 * Knowledge fields (facts, records, summary, explanation, sources, rights) are
 * not part of this schema and are rejected as unknown fields.
 */
import { PLATFORM_ONLY_FIELDS, type ContributionEnvelopeInput } from "./envelope";
import { checkReviewInterval } from "./review-intervals";
import { checkContributionRefs } from "./references";
import { Checker, ISO_UTC, isObj, type Obj } from "./check";
import { canonicalPublicHostname as canonicalHostname, HOSTNAME } from "./hostname";
import type { Schema } from "@cfworker/json-schema";
import {
  COMMON_CONTRIBUTION_REQUIRED,
  COMMON_CONTRIBUTION_SCHEMA_PROPERTIES,
  createJsonSchemaValidator,
} from "./schema-validation";

export const EXECUTION_LIMITS = {
  titleMaxChars: 160,
  purposeMaxChars: 300,
  objectiveMaxChars: 300,
  shortStringMaxChars: 200,
  literalMaxChars: 200,
  pathMaxChars: 300,
  maxSteps: 50,
  maxInputs: 20,
  maxOutputs: 20,
  maxAllowedValues: 50,
  maxTargetDomains: 10,
  maxCapabilities: 20,
  maxTargetVersions: 10,
  maxParams: 20,
  maxExpectStatuses: 10,
  maxWaitSeconds: 60,
  maxRequestsCeiling: 100,
  maxTimeoutSecondsCeiling: 600,
  maxEvidence: 20,
  maxRelated: 20,
} as const;

/** The fixed, allow-listed step vocabulary. Extending it is a schema change. */
export const STEP_TYPES = ["http_request", "extract_field", "assert", "wait"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export const SAFE_HTTP_METHODS: readonly string[] = ["GET", "HEAD"];
export const INPUT_TYPES = ["string", "number", "integer", "boolean"] as const;
export const ASSERT_OPERATORS = [
  "exists",
  "equals",
  "not_equals",
  "contains",
  "gte",
  "lte",
] as const;
export const SIDE_EFFECTS = ["read-only", "reversible-write", "irreversible-write"] as const;
export const ON_FAILURE = ["stop", "report-and-stop"] as const;
export const EXECUTION_VERIFICATION_METHODS = ["owner-tested", "simulated", "unverified"] as const;

export type Literal = string | number | boolean;

/** A value a step may use: a literal, a declared input or an earlier step's variable. */
export type ValueRef =
  { readonly literal: Literal } | { readonly input: string } | { readonly variable: string };

export interface HttpRequestStep {
  readonly id: string;
  readonly type: "http_request";
  readonly method: (typeof HTTP_METHODS)[number];
  /** Must be one of the contribution's declared targetDomains. */
  readonly domain: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, ValueRef>>;
  readonly body?: Readonly<Record<string, ValueRef>>;
  readonly expectStatus?: readonly number[];
  readonly saveAs?: string;
}
export interface ExtractFieldStep {
  readonly id: string;
  readonly type: "extract_field";
  readonly from: string;
  readonly pointer: string; // JSON Pointer, e.g. /data/id
  readonly saveAs: string;
}
export interface AssertStep {
  readonly id: string;
  readonly type: "assert";
  readonly source: ValueRef;
  readonly operator: (typeof ASSERT_OPERATORS)[number];
  readonly expected?: Literal;
}
export interface WaitStep {
  readonly id: string;
  readonly type: "wait";
  readonly seconds: number;
}
export type ExecutionStep = HttpRequestStep | ExtractFieldStep | AssertStep | WaitStep;

export interface ExecutionInputDecl {
  readonly name: string;
  readonly type: (typeof INPUT_TYPES)[number];
  readonly required: boolean;
  readonly allowedValues?: readonly Literal[];
}
export interface ExecutionOutputDecl {
  readonly name: string;
  readonly type: (typeof INPUT_TYPES)[number];
  /** Must name a saved variable. */
  readonly variable: string;
}

export interface ExecutionCompatibility {
  readonly requiredCapabilities: readonly string[];
  readonly targetVersions?: readonly { readonly domain: string; readonly version: string }[];
}

export interface ExecutionSafety {
  readonly sideEffect: (typeof SIDE_EFFECTS)[number];
  readonly requiresHumanApproval: boolean;
  readonly maxRequests: number;
  readonly timeoutSeconds: number;
  readonly onFailure: (typeof ON_FAILURE)[number];
}

/** Contributor's claim only; platform reliability and outcomes are separate. */
export interface ExecutionVerification {
  readonly method: (typeof EXECUTION_VERIFICATION_METHODS)[number];
  readonly testedAt?: string; // ISO 8601 UTC; required unless method is "unverified"
  readonly declaredConfidence?: number;
}

export interface ExecutionContributionInput extends ContributionEnvelopeInput<"execution"> {
  readonly objective: string;
  readonly inputs: readonly ExecutionInputDecl[];
  readonly outputs: readonly ExecutionOutputDecl[];
  readonly targetDomains: readonly string[];
  readonly compatibility: ExecutionCompatibility;
  readonly steps: readonly ExecutionStep[];
  /** Ids of `assert` steps that decide success. */
  readonly successChecks: readonly string[];
  readonly safety: ExecutionSafety;
  readonly verification: ExecutionVerification;
  /** Date the recipe was last observed to match its targets. */
  readonly asOf: string;
}

export interface ExecutionDomainAllowRule {
  readonly domain: string;
  readonly includeSubdomains: boolean;
}

export interface ExecutionDomainPolicy {
  readonly allowed: readonly ExecutionDomainAllowRule[];
  /** Each denied domain also denies its label-boundary subdomains. */
  readonly denied: readonly string[];
}

export type ExecutionValidation =
  | { readonly ok: true; readonly value: ExecutionContributionInput }
  | { readonly ok: false; readonly errors: readonly string[] };

const ALLOWED_KEYS = [
  "family",
  "title",
  "purpose",
  "contentType",
  "evidence",
  "licensing",
  "reviewIntervalDays",
  "related",
  "objective",
  "inputs",
  "outputs",
  "targetDomains",
  "compatibility",
  "steps",
  "successChecks",
  "safety",
  "verification",
  "asOf",
] as const;

const STEP_KEYS: Record<StepType, readonly string[]> = {
  http_request: [
    "id",
    "type",
    "method",
    "domain",
    "path",
    "query",
    "body",
    "expectStatus",
    "saveAs",
  ],
  extract_field: ["id", "type", "from", "pointer", "saveAs"],
  assert: ["id", "type", "source", "operator", "expected"],
  wait: ["id", "type", "seconds"],
};

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Absolute path; no empty segments ("//") and no dot segments. */
const PATH = /^(?!.*\/\/)(?!.*\/\.\.?(?:\/|$))\/[A-Za-z0-9._~\-/]*$/;
const POINTER = /^(?:\/[A-Za-z0-9_-]{1,64}){1,10}$/;
/** Literal strings are data tokens: no whitespace, so no sentences or commands. */
const LITERAL = /^[A-Za-z0-9._~:@/+=,-]*$/;

const literalSchema: Schema = {
  oneOf: [
    { type: "string", maxLength: EXECUTION_LIMITS.literalMaxChars, pattern: LITERAL.source },
    { type: "number" },
    { type: "boolean" },
  ],
};

const valueRefSchema: Schema = {
  oneOf: [
    {
      type: "object",
      required: ["literal"],
      properties: { literal: literalSchema },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["input"],
      properties: { input: { type: "string", pattern: NAME.source } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["variable"],
      properties: { variable: { type: "string", pattern: NAME.source } },
      additionalProperties: false,
    },
  ],
};

const valueMapSchema: Schema = {
  type: "object",
  maxProperties: EXECUTION_LIMITS.maxParams,
  propertyNames: { type: "string", pattern: NAME.source },
  additionalProperties: valueRefSchema,
};

export const EXECUTION_CONTRIBUTION_JSON_SCHEMA: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [
    ...COMMON_CONTRIBUTION_REQUIRED,
    "objective",
    "inputs",
    "outputs",
    "targetDomains",
    "compatibility",
    "steps",
    "successChecks",
    "safety",
    "verification",
    "asOf",
  ],
  properties: {
    ...COMMON_CONTRIBUTION_SCHEMA_PROPERTIES,
    family: { const: "execution" },
    related: COMMON_CONTRIBUTION_SCHEMA_PROPERTIES.related,
    objective: {
      type: "string",
      minLength: 1,
      maxLength: EXECUTION_LIMITS.objectiveMaxChars,
    },
    inputs: {
      type: "array",
      maxItems: EXECUTION_LIMITS.maxInputs,
      items: {
        type: "object",
        required: ["name", "type", "required"],
        properties: {
          name: { type: "string", pattern: NAME.source },
          type: { enum: [...INPUT_TYPES] },
          required: { type: "boolean" },
          allowedValues: {
            type: "array",
            minItems: 1,
            maxItems: EXECUTION_LIMITS.maxAllowedValues,
            items: literalSchema,
          },
        },
        additionalProperties: false,
      },
    },
    outputs: {
      type: "array",
      maxItems: EXECUTION_LIMITS.maxOutputs,
      items: {
        type: "object",
        required: ["name", "type", "variable"],
        properties: {
          name: { type: "string", pattern: NAME.source },
          type: { enum: [...INPUT_TYPES] },
          variable: { type: "string", pattern: NAME.source },
        },
        additionalProperties: false,
      },
    },
    targetDomains: {
      type: "array",
      minItems: 1,
      maxItems: EXECUTION_LIMITS.maxTargetDomains,
      items: { type: "string", pattern: HOSTNAME.source },
    },
    compatibility: {
      type: "object",
      required: ["requiredCapabilities"],
      properties: {
        requiredCapabilities: {
          type: "array",
          minItems: 1,
          maxItems: EXECUTION_LIMITS.maxCapabilities,
          items: { type: "string", pattern: SLUG.source },
        },
        targetVersions: {
          type: "array",
          maxItems: EXECUTION_LIMITS.maxTargetVersions,
          items: {
            type: "object",
            required: ["domain", "version"],
            properties: {
              domain: { type: "string", pattern: HOSTNAME.source },
              version: { type: "string", pattern: SLUG.source },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: EXECUTION_LIMITS.maxSteps,
      items: {
        oneOf: [
          {
            type: "object",
            required: ["id", "type", "method", "domain", "path"],
            properties: {
              id: { type: "string", pattern: STEP_ID.source },
              type: { const: "http_request" },
              method: { enum: [...HTTP_METHODS] },
              domain: { type: "string", pattern: HOSTNAME.source },
              path: {
                type: "string",
                maxLength: EXECUTION_LIMITS.pathMaxChars,
                pattern: PATH.source,
              },
              query: valueMapSchema,
              body: valueMapSchema,
              expectStatus: {
                type: "array",
                minItems: 1,
                maxItems: EXECUTION_LIMITS.maxExpectStatuses,
                items: { type: "integer", minimum: 100, maximum: 599 },
              },
              saveAs: { type: "string", pattern: NAME.source },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["id", "type", "from", "pointer", "saveAs"],
            properties: {
              id: { type: "string", pattern: STEP_ID.source },
              type: { const: "extract_field" },
              from: { type: "string", pattern: NAME.source },
              pointer: { type: "string", pattern: POINTER.source },
              saveAs: { type: "string", pattern: NAME.source },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["id", "type", "source", "operator"],
            properties: {
              id: { type: "string", pattern: STEP_ID.source },
              type: { const: "assert" },
              source: valueRefSchema,
              operator: { enum: [...ASSERT_OPERATORS] },
              expected: literalSchema,
            },
            allOf: [
              {
                if: {
                  properties: { operator: { const: "exists" } },
                  required: ["operator"],
                },
                then: { not: { required: ["expected"] } },
              },
              {
                if: {
                  properties: {
                    operator: { enum: ["equals", "not_equals", "contains", "gte", "lte"] },
                  },
                  required: ["operator"],
                },
                then: { required: ["expected"] },
              },
              {
                if: {
                  properties: { operator: { enum: ["gte", "lte"] } },
                  required: ["operator"],
                },
                then: { properties: { expected: { type: "number" } } },
              },
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["id", "type", "seconds"],
            properties: {
              id: { type: "string", pattern: STEP_ID.source },
              type: { const: "wait" },
              seconds: { type: "integer", minimum: 1, maximum: EXECUTION_LIMITS.maxWaitSeconds },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    successChecks: {
      type: "array",
      minItems: 1,
      maxItems: EXECUTION_LIMITS.maxSteps,
      items: { type: "string", pattern: STEP_ID.source },
    },
    safety: {
      type: "object",
      required: [
        "sideEffect",
        "requiresHumanApproval",
        "maxRequests",
        "timeoutSeconds",
        "onFailure",
      ],
      properties: {
        sideEffect: { enum: [...SIDE_EFFECTS] },
        requiresHumanApproval: { type: "boolean" },
        maxRequests: {
          type: "integer",
          minimum: 1,
          maximum: EXECUTION_LIMITS.maxRequestsCeiling,
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: EXECUTION_LIMITS.maxTimeoutSecondsCeiling,
        },
        onFailure: { enum: [...ON_FAILURE] },
      },
      additionalProperties: false,
    },
    verification: {
      type: "object",
      required: ["method"],
      properties: {
        method: { enum: [...EXECUTION_VERIFICATION_METHODS] },
        testedAt: { type: "string", pattern: ISO_UTC.source },
        declaredConfidence: { type: "number", minimum: 0, maximum: 1 },
      },
      allOf: [
        {
          if: {
            properties: { method: { enum: ["owner-tested", "simulated"] } },
            required: ["method"],
          },
          then: { required: ["testedAt"] },
        },
      ],
      additionalProperties: false,
    },
    asOf: { type: "string", pattern: ISO_UTC.source },
  },
  additionalProperties: false,
};

export const validateExecutionContributionJsonSchema = createJsonSchemaValidator(
  EXECUTION_CONTRIBUTION_JSON_SCHEMA,
);

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const oneOf = (list: readonly unknown[], v: unknown): boolean => list.includes(v);

class ExecutionChecker extends Checker {
  readonly inputNames = new Set<string>();
  readonly variables = new Set<string>();
  domains = new Set<string>();

  name(v: unknown, path: string, re: RegExp = NAME): string | undefined {
    if (typeof v !== "string" || !re.test(v)) {
      this.err(path, "must be a valid identifier");
      return undefined;
    }
    return v;
  }

  literal(v: unknown, path: string): void {
    if (typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) this.err(path, "must be a finite number");
      return;
    }
    if (typeof v !== "string") return this.err(path, "must be a string, number or boolean");
    if (v.length > EXECUTION_LIMITS.literalMaxChars) {
      this.err(path, `exceeds ${EXECUTION_LIMITS.literalMaxChars} characters`);
    }
    if (!LITERAL.test(v)) this.err(path, "literal strings may not contain whitespace or free text");
  }

  valueRef(v: unknown, path: string): void {
    const o = this.obj(v, path, ["literal", "input", "variable"]);
    if (!o) return;
    const present = ["literal", "input", "variable"].filter((k) => hasOwn(o, k));
    if (present.length !== 1)
      return this.err(path, "must contain exactly one of literal, input, variable");
    if (present[0] === "literal") this.literal(o.literal, `${path}.literal`);
    else if (present[0] === "input") {
      if (typeof o.input !== "string" || !this.inputNames.has(o.input)) {
        this.err(`${path}.input`, "must reference a declared input");
      }
    } else if (typeof o.variable !== "string" || !this.variables.has(o.variable)) {
      this.err(`${path}.variable`, "must reference a variable saved by an earlier step");
    }
  }

  valueMap(v: unknown, path: string): void {
    if (!isObj(v)) return this.err(path, "must be an object");
    const keys = Object.keys(v);
    if (keys.length > EXECUTION_LIMITS.maxParams) {
      this.err(path, `exceeds ${EXECUTION_LIMITS.maxParams} entries`);
    }
    for (const k of keys.slice(0, EXECUTION_LIMITS.maxParams)) {
      if (!NAME.test(k)) this.err(`${path}.${k}`, "key must be a valid identifier");
      this.valueRef(v[k], `${path}.${k}`);
    }
  }

  saveVariable(v: unknown, path: string): void {
    const n = this.name(v, path);
    if (n === undefined) return;
    if (this.variables.has(n) || this.inputNames.has(n)) this.err(path, "name is already in use");
    this.variables.add(n);
  }
}

function int(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

export type ExecutionDomainPolicyParseResult =
  | { readonly ok: true; readonly policy: ExecutionDomainPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Parse and validate the platform-owned JSON policy; contributors never supply it. */
export function parseExecutionDomainPolicy(value: unknown): ExecutionDomainPolicyParseResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      errors: ["EXECUTION_DOMAIN_POLICY_JSON: must be configured"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return {
      ok: false,
      errors: ["EXECUTION_DOMAIN_POLICY_JSON: must contain valid JSON"],
    };
  }
  if (!isObj(parsed)) {
    return {
      ok: false,
      errors: ["EXECUTION_DOMAIN_POLICY_JSON: must be an object"],
    };
  }

  const errors: string[] = [];
  if (Object.keys(parsed).some((key) => key !== "allowed" && key !== "denied")) {
    errors.push("EXECUTION_DOMAIN_POLICY_JSON: only allowed and denied are supported");
  }

  const allowed: ExecutionDomainAllowRule[] = [];
  const seenAllowed = new Set<string>();
  if (!Array.isArray(parsed.allowed) || parsed.allowed.length === 0) {
    errors.push("EXECUTION_DOMAIN_POLICY_JSON.allowed: requires at least one rule");
  } else {
    parsed.allowed.forEach((rule, index) => {
      const path = `EXECUTION_DOMAIN_POLICY_JSON.allowed[${index}]`;
      if (!isObj(rule)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (Object.keys(rule).some((key) => key !== "domain" && key !== "includeSubdomains")) {
        errors.push(`${path}: only domain and includeSubdomains are supported`);
      }
      const domain = canonicalHostname(rule.domain);
      if (domain === undefined) errors.push(`${path}.domain: must be a non-special DNS hostname`);
      if (typeof rule.includeSubdomains !== "boolean") {
        errors.push(`${path}.includeSubdomains: must be an explicit boolean`);
      }
      if (domain === undefined || typeof rule.includeSubdomains !== "boolean") return;
      if (seenAllowed.has(domain)) errors.push(`${path}.domain: duplicate domain`);
      else {
        seenAllowed.add(domain);
        allowed.push({ domain, includeSubdomains: rule.includeSubdomains });
      }
    });
  }

  const denied: string[] = [];
  const seenDenied = new Set<string>();
  if (!Array.isArray(parsed.denied)) {
    errors.push("EXECUTION_DOMAIN_POLICY_JSON.denied: must be an array");
  } else {
    parsed.denied.forEach((value, index) => {
      const path = `EXECUTION_DOMAIN_POLICY_JSON.denied[${index}]`;
      const domain = canonicalHostname(value);
      if (domain === undefined) {
        errors.push(`${path}: must be a non-special DNS hostname`);
        return;
      }
      if (seenDenied.has(domain)) errors.push(`${path}: duplicate domain`);
      else {
        seenDenied.add(domain);
        denied.push(domain);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: { allowed, denied } };
}

function isAllowedByExecutionDomainPolicy(value: string, policy: ExecutionDomainPolicy): boolean {
  const hostname = canonicalHostname(value);
  if (hostname === undefined) return false;
  if (policy.denied.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return false;
  }
  return policy.allowed.some(
    (rule) =>
      hostname === rule.domain || (rule.includeSubdomains && hostname.endsWith(`.${rule.domain}`)),
  );
}

/** Mutable platform policy is checked only before writes, never during integrity retrieval. */
export function checkExecutionDomainPolicy(
  content: ExecutionContributionInput,
  policy: ExecutionDomainPolicy,
): readonly string[] {
  const errors: string[] = [];
  content.targetDomains.forEach((domain, index) => {
    if (!isAllowedByExecutionDomainPolicy(domain, policy)) {
      errors.push(
        `targetDomains[${index}]: is not allowed by the platform Execution domain policy`,
      );
    }
  });
  content.steps.forEach((step, index) => {
    if (step.type === "http_request" && !isAllowedByExecutionDomainPolicy(step.domain, policy)) {
      errors.push(`steps[${index}].domain: is not allowed by the platform Execution domain policy`);
    }
  });
  return errors;
}

function matchesDeclaredTarget(hostname: unknown, declared: ReadonlySet<string>): boolean {
  const canonical = canonicalHostname(hostname);
  if (canonical === undefined) return false;
  for (const domain of declared) {
    if (canonical === domain || canonical.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** Validate untrusted input as an Execution contribution. Never throws. */
export function validateExecutionContribution(input: unknown): ExecutionValidation {
  const schemaErrors = validateExecutionContributionJsonSchema(input);
  const c = new ExecutionChecker();
  if (!isObj(input)) return { ok: false, errors: ["input: must be an object"] };
  const L = EXECUTION_LIMITS;

  for (const k of Object.keys(input)) {
    if ((PLATFORM_ONLY_FIELDS as readonly string[]).includes(k)) {
      c.err(k, "platform-computed field cannot be set by contributors");
    } else if (!(ALLOWED_KEYS as readonly string[]).includes(k)) c.err(k, "unknown field");
  }

  // Envelope
  if (input.family !== "execution") c.err("family", 'must be "execution"');
  c.str(input.title, "title", L.titleMaxChars);
  c.str(input.purpose, "purpose", L.purposeMaxChars);
  c.str(input.contentType, "contentType", L.shortStringMaxChars);
  for (const e of checkReviewInterval("execution", input.contentType, input.reviewIntervalDays)) {
    if (e.path !== "contentType" || typeof input.contentType === "string") c.err(e.path, e.message);
  }
  c.list(input.evidence, "evidence", L.maxEvidence).forEach((e, i) => {
    const o = c.obj(e, `evidence[${i}]`, ["kind", "uri"]);
    if (!o) return;
    c.str(o.kind, `evidence[${i}].kind`, L.shortStringMaxChars);
    c.uri(o.uri, `evidence[${i}].uri`);
  });
  const lic = c.obj(input.licensing, "licensing", ["license", "dataPermission"]);
  if (lic) {
    c.str(lic.license, "licensing.license", L.shortStringMaxChars);
    c.str(lic.dataPermission, "licensing.dataPermission", L.shortStringMaxChars);
  }
  if (input.related !== undefined) {
    checkContributionRefs(c, input.related, "related", "execution", L.maxRelated);
  }

  c.str(input.objective, "objective", L.objectiveMaxChars);

  // Target domains: the only hosts any step may address.
  c.list(input.targetDomains, "targetDomains", L.maxTargetDomains, 1).forEach((d, i) => {
    const domain = canonicalHostname(d);
    if (domain === undefined) {
      c.err(
        `targetDomains[${i}]`,
        "must be a DNS hostname outside the IANA Special-Use Domain Names registry (no scheme, port, path, wildcard or IP address)",
      );
    } else if (c.domains.has(domain)) c.err(`targetDomains[${i}]`, "duplicate domain");
    else c.domains.add(domain);
  });

  // Declared inputs
  c.list(input.inputs, "inputs", L.maxInputs).forEach((d, i) => {
    const p = `inputs[${i}]`;
    const o = c.obj(d, p, ["name", "type", "required", "allowedValues"]);
    if (!o) return;
    const n = c.name(o.name, `${p}.name`);
    if (n !== undefined) {
      if (c.inputNames.has(n)) c.err(`${p}.name`, "duplicate input name");
      c.inputNames.add(n);
    }
    if (!oneOf(INPUT_TYPES, o.type))
      c.err(`${p}.type`, `must be one of: ${INPUT_TYPES.join(", ")}`);
    if (typeof o.required !== "boolean") c.err(`${p}.required`, "must be a boolean");
    if (o.allowedValues !== undefined) {
      c.list(o.allowedValues, `${p}.allowedValues`, L.maxAllowedValues, 1).forEach((v, j) =>
        c.literal(v, `${p}.allowedValues[${j}]`),
      );
    }
  });

  // Compatibility
  const compat = c.obj(input.compatibility, "compatibility", [
    "requiredCapabilities",
    "targetVersions",
  ]);
  if (compat) {
    c.list(
      compat.requiredCapabilities,
      "compatibility.requiredCapabilities",
      L.maxCapabilities,
      1,
    ).forEach((v, i) => c.name(v, `compatibility.requiredCapabilities[${i}]`, SLUG));
    if (compat.targetVersions !== undefined) {
      c.list(compat.targetVersions, "compatibility.targetVersions", L.maxTargetVersions).forEach(
        (t, i) => {
          const p = `compatibility.targetVersions[${i}]`;
          const o = c.obj(t, p, ["domain", "version"]);
          if (!o) return;
          const domain = canonicalHostname(o.domain);
          if (domain === undefined || !c.domains.has(domain)) {
            c.err(`${p}.domain`, "must be a declared target domain");
          }
          c.name(o.version, `${p}.version`, SLUG);
        },
      );
    }
  }

  // Steps
  const stepIds = new Set<string>();
  const assertIds = new Set<string>();
  const stepList = c.list(input.steps, "steps", L.maxSteps, 1);
  let httpCount = 0;
  let writes = false;
  stepList.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (!isObj(s)) return c.err(p, "must be an object");
    const type = s.type;
    if (!oneOf(STEP_TYPES, type)) {
      return c.err(`${p}.type`, `unknown step type; must be one of: ${STEP_TYPES.join(", ")}`);
    }
    const o = c.obj(s, p, STEP_KEYS[type as StepType]) as Obj;
    const id = c.name(o.id, `${p}.id`, STEP_ID);
    if (id !== undefined) {
      if (stepIds.has(id)) c.err(`${p}.id`, "duplicate step id");
      stepIds.add(id);
    }
    switch (type as StepType) {
      case "http_request": {
        httpCount++;
        if (!oneOf(HTTP_METHODS, o.method)) {
          c.err(`${p}.method`, `must be one of: ${HTTP_METHODS.join(", ")}`);
        } else if (!SAFE_HTTP_METHODS.includes(o.method as string)) writes = true;
        if (!matchesDeclaredTarget(o.domain, c.domains)) {
          c.err(`${p}.domain`, "must be one of the declared targetDomains");
        }
        if (typeof o.path !== "string" || !PATH.test(o.path) || o.path.length > L.pathMaxChars) {
          c.err(`${p}.path`, "must be an absolute path of URL-safe characters");
        }
        if (o.query !== undefined) c.valueMap(o.query, `${p}.query`);
        if (o.body !== undefined) c.valueMap(o.body, `${p}.body`);
        if (o.expectStatus !== undefined) {
          c.list(o.expectStatus, `${p}.expectStatus`, L.maxExpectStatuses, 1).forEach((v, j) => {
            if (!int(v, 100, 599)) c.err(`${p}.expectStatus[${j}]`, "must be an HTTP status code");
          });
        }
        if (o.saveAs !== undefined) c.saveVariable(o.saveAs, `${p}.saveAs`);
        break;
      }
      case "extract_field":
        if (typeof o.from !== "string" || !c.variables.has(o.from)) {
          c.err(`${p}.from`, "must reference a variable saved by an earlier step");
        }
        if (typeof o.pointer !== "string" || !POINTER.test(o.pointer)) {
          c.err(`${p}.pointer`, "must be a JSON Pointer of simple segments");
        }
        c.saveVariable(o.saveAs, `${p}.saveAs`);
        break;
      case "assert": {
        if (id !== undefined) assertIds.add(id);
        c.valueRef(o.source, `${p}.source`);
        if (!oneOf(ASSERT_OPERATORS, o.operator)) {
          c.err(`${p}.operator`, `must be one of: ${ASSERT_OPERATORS.join(", ")}`);
        } else if (o.operator === "exists") {
          if (o.expected !== undefined)
            c.err(`${p}.expected`, 'not allowed with operator "exists"');
        } else if (o.expected === undefined)
          c.err(`${p}.expected`, "is required for this operator");
        else {
          c.literal(o.expected, `${p}.expected`);
          if ((o.operator === "gte" || o.operator === "lte") && typeof o.expected !== "number") {
            c.err(`${p}.expected`, "must be a number for gte/lte");
          }
        }
        break;
      }
      case "wait":
        if (!int(o.seconds, 1, L.maxWaitSeconds)) {
          c.err(`${p}.seconds`, `must be an integer from 1 to ${L.maxWaitSeconds}`);
        }
        break;
    }
  });

  // Success checks must name assert steps.
  c.list(input.successChecks, "successChecks", L.maxSteps, 1).forEach((v, i) => {
    if (typeof v !== "string" || !assertIds.has(v)) {
      c.err(`successChecks[${i}]`, "must be the id of an assert step");
    }
  });

  // Outputs
  const outNames = new Set<string>();
  c.list(input.outputs, "outputs", L.maxOutputs).forEach((d, i) => {
    const p = `outputs[${i}]`;
    const o = c.obj(d, p, ["name", "type", "variable"]);
    if (!o) return;
    const n = c.name(o.name, `${p}.name`);
    if (n !== undefined) {
      if (outNames.has(n)) c.err(`${p}.name`, "duplicate output name");
      outNames.add(n);
    }
    if (!oneOf(INPUT_TYPES, o.type))
      c.err(`${p}.type`, `must be one of: ${INPUT_TYPES.join(", ")}`);
    if (typeof o.variable !== "string" || !c.variables.has(o.variable)) {
      c.err(`${p}.variable`, "must reference a saved variable");
    }
  });

  // Safety boundaries
  const safety = c.obj(input.safety, "safety", [
    "sideEffect",
    "requiresHumanApproval",
    "maxRequests",
    "timeoutSeconds",
    "onFailure",
  ]);
  if (safety) {
    if (!oneOf(SIDE_EFFECTS, safety.sideEffect)) {
      c.err("safety.sideEffect", `must be one of: ${SIDE_EFFECTS.join(", ")}`);
    } else {
      if (writes && safety.sideEffect === "read-only") {
        c.err("safety.sideEffect", "cannot be read-only when a step uses a writing HTTP method");
      }
      if (safety.sideEffect === "irreversible-write" && safety.requiresHumanApproval !== true) {
        c.err("safety.requiresHumanApproval", "must be true for irreversible-write");
      }
    }
    if (typeof safety.requiresHumanApproval !== "boolean") {
      c.err("safety.requiresHumanApproval", "must be a boolean");
    }
    if (!int(safety.maxRequests, 1, L.maxRequestsCeiling)) {
      c.err("safety.maxRequests", `must be an integer from 1 to ${L.maxRequestsCeiling}`);
    } else if (safety.maxRequests < httpCount) {
      c.err("safety.maxRequests", "is lower than the number of http_request steps");
    }
    if (!int(safety.timeoutSeconds, 1, L.maxTimeoutSecondsCeiling)) {
      c.err("safety.timeoutSeconds", `must be an integer from 1 to ${L.maxTimeoutSecondsCeiling}`);
    }
    if (!oneOf(ON_FAILURE, safety.onFailure)) {
      c.err("safety.onFailure", `must be one of: ${ON_FAILURE.join(", ")}`);
    }
  }

  // Verification and freshness
  const ver = c.obj(input.verification, "verification", [
    "method",
    "testedAt",
    "declaredConfidence",
  ]);
  if (ver) {
    if (!oneOf(EXECUTION_VERIFICATION_METHODS, ver.method)) {
      c.err("verification.method", `must be one of: ${EXECUTION_VERIFICATION_METHODS.join(", ")}`);
    } else if (ver.method !== "unverified" && ver.testedAt === undefined) {
      c.err("verification.testedAt", "is required unless method is unverified");
    }
    c.date(ver.testedAt, "verification.testedAt", { optional: true });
    const dc = ver.declaredConfidence;
    if (dc !== undefined && (typeof dc !== "number" || !(dc >= 0 && dc <= 1))) {
      c.err("verification.declaredConfidence", "must be a number from 0 to 1");
    }
  }
  c.date(input.asOf, "asOf");

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  if (schemaErrors.length > 0) return { ok: false, errors: schemaErrors };
  return { ok: true, value: input as unknown as ExecutionContributionInput };
}
