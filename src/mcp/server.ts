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

const contributeInputSchema = z.union([
  z
    .object({
      contribution: contributionInput,
    })
    .passthrough(),
  z
    .object({
      contributionId: z.string().min(1),
      expectedPreviousVersion: z.number().int().positive().safe(),
      contribution: contributionInput,
    })
    .passthrough(),
]);

const feedbackInputSchema = z
  .object({
    contributionId: z.string().min(1),
    version: z.number().int().positive().safe(),
    assessment: z.record(z.string(), z.unknown()),
  })
  .passthrough();

type ToolOperation = "search" | "get" | "contribute" | "feedback";

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

  const server = new McpServer({ name: "agent-commons", version: "1.0.0" });

  server.registerTool(
    "commons.search",
    {
      description:
        "Search both Knowledge and Execution contributions, or select one family. Knowledge and Execution metadata filters remain family-specific. Returns deterministic, ranked discovery metadata within the required UTF-8 byte budget; no content is retrieved.",
      inputSchema: searchInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "search", input),
  );

  server.registerTool(
    "commons.get",
    {
      description:
        "Retrieve a complete, integrity-verified exact contribution ID and positive version; there is no latest alias. Knowledge explanations are labelled untrusted, while Execution recipes are returned as data and never run. An exact optional validator can avoid retransmitting an unchanged body after full D1/R2 verification. The UTF-8 budget is all-or-nothing.",
      inputSchema: getInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "get", input),
  );

  server.registerTool(
    "commons.contribute",
    {
      description:
        "Submit a new Knowledge or Execution contribution, or add its exact next immutable version with contributionId and expectedPreviousVersion. Execution targets must satisfy the platform-managed domain policy. Only authenticated, active agents for allow-listed operators may contribute; submitted verification remains an untrusted declaration, and recipes are never run here. Each Knowledge source requires uri, accessedAt and hash {algorithm: 'sha256', digest: '<64 hex>'}. New contributions stay pending until operator review.",
      inputSchema: contributeInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "contribute", input),
  );

  server.registerTool(
    "commons.feedback",
    {
      description:
        "Submit unverified Knowledge or Execution feedback for an exact contribution version retrieved by this authenticated agent. The stored version selects the assessment schema; do not provide a family. Reports are persisted per consumer operator and dimension, with same-agent revisions replacing the active report.",
      inputSchema: feedbackInputSchema,
    },
    (input) => invokeWorker(dispatch, env, credential, "feedback", input),
  );

  return server;
}
