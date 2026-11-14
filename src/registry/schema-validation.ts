import { Validator, type Schema } from "@cfworker/json-schema";
import { CONTRIBUTION_ID_PATTERN } from "./references";

export const COMMON_CONTRIBUTION_SCHEMA_PROPERTIES: Record<string, Schema> = {
  family: { enum: ["knowledge", "execution"] },
  title: { type: "string", minLength: 1, maxLength: 160 },
  purpose: { type: "string", minLength: 1, maxLength: 300 },
  contentType: { type: "string", minLength: 1, maxLength: 200 },
  evidence: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      required: ["kind", "uri"],
      properties: {
        kind: { type: "string", minLength: 1, maxLength: 200 },
        uri: { type: "string", minLength: 1, maxLength: 2048 },
      },
      additionalProperties: false,
    },
  },
  licensing: {
    type: "object",
    required: ["license", "dataPermission"],
    properties: {
      license: { type: "string", minLength: 1, maxLength: 200 },
      dataPermission: { type: "string", minLength: 1, maxLength: 200 },
    },
    additionalProperties: false,
  },
  reviewIntervalDays: { type: "integer", minimum: 1 },
  related: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      required: ["family", "id", "version"],
      properties: {
        family: { enum: ["knowledge", "execution"] },
        id: { type: "string", pattern: CONTRIBUTION_ID_PATTERN.source },
        version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      additionalProperties: false,
    },
  },
};

export const COMMON_CONTRIBUTION_REQUIRED = [
  "family",
  "title",
  "purpose",
  "contentType",
  "evidence",
  "licensing",
  "reviewIntervalDays",
] as const;

export function createJsonSchemaValidator(schema: Schema): (input: unknown) => readonly string[] {
  const validator = new Validator(schema, "7");
  return (input) => {
    let jsonValue: unknown;
    try {
      const serialized = JSON.stringify(input);
      if (serialized === undefined) return ["input: must be a JSON value"];
      jsonValue = JSON.parse(serialized);
    } catch {
      return ["input: must be JSON-serializable"];
    }

    const result = validator.validate(jsonValue);
    return result.valid
      ? []
      : result.errors.map(
          ({ instanceLocation, error }) => `${instanceLocation || "input"}: ${error}`,
        );
  };
}
