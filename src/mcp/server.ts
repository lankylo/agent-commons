import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const contributionInput = z
  .record(z.string(), z.unknown())
  .describe(
    "A Knowledge contribution uses family='knowledge' fields (facts/records/summary, sources, rights, verification and asOf); source and evidence URLs and declared permission combinations are checked against platform policy. These checks accept declarations as submitted and do not verify ownership or truth. An Execution contribution uses family='execution' with objective, inputs, outputs, targetDomains, compatibility, declarative steps, safety, verification and asOf. Execution steps are never run here.",
  );

const searchInputSchema = z
  .object({
    query: z.string().describe("Plain-text search terms; search is deterministic and LLM-free."),
    family: z
      .enum(["knowledge", "execution"])
      .optional()
      .describe("Omit to search both Knowledge and Execution contributions."),
    filters: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Knowledge filters: verificationMethod and permittedUse. Execution filters: verificationMethod, targetDomain, requiredCapability, sideEffect and requiresHumanApproval.",
      ),
    contentType: z.string().optional(),
    limit: z.number().int().optional(),
    maxUtf8Bytes: z.number().int().positive().safe(),
  })
  .passthrough();

const getInputSchema = z
  .object({
    contributionId: z.string().min(1),
    version: z.number().int().positive().safe(),
    validator: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional exact {contributionId, version, contentHash} validator. Retrieval always verifies D1/R2 integrity first; there is no latest-version alias.",
      ),
    maxUtf8Bytes: z.number().int().positive().safe(),
  })
  .passthrough();

// One flat object, not a union: Anthropic's API rejects a tool whose input schema has oneOf, anyOf
// or allOf at the top level, and one such tool fails the whole request, so the model gets no tools.
// The REST handler still requires contributionId and expectedPreviousVersion together.
const contributeInputSchema = z
  .object({
    contribution: contributionInput,
    contributionId: z
      .string()
      .min(1)
      .optional()
      .describe("Only to add a new version: the existing contribution's ID."),
    expectedPreviousVersion: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe("Only to add a new version, with contributionId: the current latest version."),
  })
  .passthrough();

const feedbackInputSchema = z
  .object({
    contributionId: z.string().min(1),
    version: z.number().int().positive().safe(),
    assessment: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const purchaseInputSchema = z
  .object({
    contributionId: z.string().min(1),
    version: z.number().int().positive().safe(),
    idempotencyKey: z
      .string()
      .describe("8-128 characters; reuse it to retry safely without paying twice."),
    method: z.enum(["provider", "balance"]).optional(),
  })
  .passthrough();

type ToolOperation = "search" | "get" | "contribute" | "feedback" | "purchase";

/**
 * What the server tells clients at initialize. Clients may treat it as a hint only, so the tool
 * descriptions below also say when to call each tool. Nothing here enforces anything: every rule
 * (review, capacity, prices, spending limits, schemas) is enforced by the Worker and D1.
 */
export const SERVER_INSTRUCTIONS =
  "Agent Commons is a shared, operator-reviewed registry of developer knowledge (error causes and fixes, API limits, configuration facts) and tested HTTP recipes. When you hit an error, or need an API's exact limits or behaviour, call commons.search with the error code or its first line before debugging from scratch, then read a result with commons.get. After using a record, report whether it worked with commons.feedback.";

/** Tool descriptions say when to call the tool first, then what it returns. */
export const TOOL_DESCRIPTIONS = {
  search:
    "Search Agent Commons for reviewed developer knowledge (error causes and fixes, API limits, configuration facts) and tested HTTP recipes. Call it when you hit an error message, before relying on an API's limits or behaviour, or before writing a multi-step HTTP check. Search the distinctive part of an error (its code or first line), at most 12 words and 256 characters, not a stack trace. Returns ranked titles, prices and trust signals within maxUtf8Bytes, not content; read one with commons.get.",
  get: "Read one search result in full, using the contributionId and version that commons.search returned. Knowledge comes with pinned, hashed sources; any explanation text is untrusted. Execution recipes are returned as data for you to run; nothing runs here. If the result is larger than maxUtf8Bytes nothing is returned (8000 fits most records). A paid version needs commons.purchase first. Pass validator {contributionId, version, contentHash} to skip a body you already hold.",
  contribute:
    "Add a record other agents can reuse: Knowledge (facts with pinned, hashed sources) or an Execution recipe (declarative HTTP steps). Use it when you have verified something others would otherwise rediscover. Only agents of allow-listed operators can contribute, and new records stay pending until operator review. For a new version, pass contributionId and expectedPreviousVersion. Each Knowledge source needs uri, accessedAt and hash {algorithm: 'sha256', digest: '<64 hex>'}.",
  feedback:
    "After you use a record, report whether it worked, with the contributionId and version you retrieved and an assessment. Do not pass a family; the record decides the assessment schema. Success reports from independent operators are what verify recipes and can earn an open validation reward. Sending again replaces your earlier report.",
  purchase:
    "Buy access to a paid record version (commons.search and commons.get show the price); every agent of your operator can then read it. Free versions need no purchase. Pays from your agent's USDC balance (method balance), within your operator's spending limits. Reuse idempotencyKey to retry without paying twice.",
} as const;

/** The existing Worker fetch entry; every tool call goes through its shared REST handlers. */
export type WorkerDispatch = (request: Request, env: unknown) => Promise<Response>;

interface JsonObject {
  readonly [key: string]: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResult(body: JsonObject, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    ...(isError ? { isError: true } : {}),
  };
}

function internalError(operation: ToolOperation) {
  const message =
    operation === "get"
      ? "Retrieval is unavailable."
      : operation === "contribute"
        ? "Contribution could not be saved."
        : operation === "feedback"
          ? "Feedback could not be saved."
          : operation === "purchase"
            ? "Purchase is unavailable."
            : "Search is unavailable.";
  return toolResult({ error: { code: "internal_error", message } }, true);
}

async function invokeWorker(
  dispatch: WorkerDispatch,
  env: unknown,
  credential: string,
  operation: ToolOperation,
  input: Record<string, unknown>,
) {
  try {
    const response = await dispatch(
      new Request(`https://agent-commons.local/v1/commons/${operation}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      env,
    );
    const body: unknown = await response.json();
    if (!isJsonObject(body)) return internalError(operation);
    return toolResult(body, !response.ok);
  } catch {
    return internalError(operation);
  }
}

export function createCommonsMcpServer(
  env: unknown,
  credential: string,
  dispatch: WorkerDispatch,
): McpServer {
  if (!credential.trim()) {
    throw new Error("An agent credential is required in process configuration.");
  }

  const server = new McpServer(
    { name: "agent-commons", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "commons.search",
    {
      description: TOOL_DESCRIPTIONS.search,
      inputSchema: searchInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "search", input),
  );

  server.registerTool(
    "commons.get",
    {
      description: TOOL_DESCRIPTIONS.get,
      inputSchema: getInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "get", input),
  );

  server.registerTool(
    "commons.contribute",
    {
      description: TOOL_DESCRIPTIONS.contribute,
      inputSchema: contributeInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "contribute", input),
  );

  server.registerTool(
    "commons.feedback",
    {
      description: TOOL_DESCRIPTIONS.feedback,
      inputSchema: feedbackInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "feedback", input),
  );

  server.registerTool(
    "commons.purchase",
    {
      description: TOOL_DESCRIPTIONS.purchase,
      inputSchema: purchaseInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "purchase", input),
  );

  return server;
}
