import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { ContributionRegistry } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly token: string;
}

interface ApiPayload {
  readonly schemaVersion?: string;
  readonly accepted?: boolean;
  readonly contributionId?: string;
  readonly version?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let owner: Actor;
let reviewer: Actor;
let reviewerSibling: Actor;
let otherReviewer: Actor;
let registry: ContributionRegistry;
const clock = new Date("2026-11-15T00:00:00.000Z");
let contributionNumber = 0;
let agentNumber = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-feedback-"));
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.d1-local.jsonc",
      "--persist-to",
      dir,
    ],
    { stdio: "pipe" },
  );
  proxy = await getPlatformProxy<RegistryEnv>({
    configPath: "wrangler.registry-local.jsonc",
    persist: { path: join(dir, "v3") },
  });
  db = proxy.env.DB;
  identity = new IdentityRepository(db);
  credentials = new CredentialService(db, { now: () => clock });
  owner = await createOperatorActor("Feedback Owner", true);
  reviewer = await createOperatorActor("Feedback Reviewer");
  reviewerSibling = await createAgent(reviewer.operatorId, "Feedback Reviewer Sibling");
  otherReviewer = await createOperatorActor("Other Feedback Reviewer");
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function createOperatorActor(name: string, allowListed = false): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  return createAgent(operator.id, name);
}

async function createAgent(operatorId: OperatorId, name: string): Promise<Actor> {
  const agent = await identity.registerAgent(operatorId, {
    displayName: `${name} Agent ${++agentNumber}`,
  });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, operatorId, token: issued.token };
}

function env() {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    RATE_LIMIT_AGENT_LIMIT: 1000,
    RATE_LIMIT_OPERATOR_LIMIT: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => clock,
  };
}

async function call(
  operation: "get" | "feedback",
  body: Record<string, unknown>,
  actor: Actor | null,
): Promise<Response> {
  const headers = new Headers();
  if (actor) headers.set("Authorization", `Bearer ${actor.token}`);
  return worker.fetch(
    new Request(`https://example.com/v1/commons/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env() as never,
  );
}

async function payload(response: Response): Promise<ApiPayload> {
  return (await response.json()) as ApiPayload;
}

async function createKnowledge(): Promise<string> {
  const result = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: `Feedback Knowledge ${++contributionNumber}`,
  });
  if (!result.ok) throw new Error(`Failed to create Knowledge fixture: ${result.error.code}`);
  await listVersion(proxy.env, result.contribution.id);
  return result.contribution.id;
}

async function createExecution(): Promise<string> {
  const result = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_EXECUTION_SEED,
    title: `Feedback Execution ${++contributionNumber}`,
  });
  if (!result.ok) throw new Error(`Failed to create Execution fixture: ${result.error.code}`);
  await listVersion(proxy.env, result.contribution.id);
  return result.contribution.id;
}

async function retrieve(contributionId: string, actor = reviewer): Promise<void> {
  const response = await call("get", { contributionId, version: 1, maxUtf8Bytes: 64000 }, actor);
  expect(response.status).toBe(200);
}

function feedbackRequest(
  contributionId: string,
  assessment: Record<string, unknown>,
): Record<string, unknown> {
  return { contributionId, version: 1, assessment };
}

function knowledgeAccuracy(finding: string, uri = "https://example.com/public-docs") {
  return {
    accuracy: {
      finding,
      scope: "The documented response fields",
      evidence: [{ kind: "documentation", uri }],
    },
  };
}

function validKnowledgeAssessment() {
  return {
    accuracy: knowledgeAccuracy("mixed").accuracy,
    usefulness: {
      finding: "not_used",
      context: "The agent has not applied this content",
      evidence: [],
    },
    staleness: {
      finding: "not_checked",
      observedAt: "2026-11-15T00:00:00Z",
      evidence: [],
    },
  };
}

function validExecutionAssessment() {
  return {
    outcome: {
      finding: "success",
      observedAt: "2026-11-15T00:00:00Z",
      steps: [
        { stepId: "fetch", result: "passed", httpStatus: 200 },
        { stepId: "extract", result: "passed" },
        { stepId: "check_echo", result: "passed" },
      ],
    },
    compatibility: {
      finding: "compatible",
      observedAt: "2026-11-15T00:00:00Z",
      capabilities: [
        { name: "http-get", result: "available" },
        { name: "json-parse", result: "available" },
      ],
      targetVersions: [],
    },
  };
}

describe("worker feedback endpoint", () => {
  it("requires an exact-version receipt and excludes the contributor operator uniformly", async () => {
    const contributionId = await createKnowledge();
    const unauthenticated = await payload(
      await call("feedback", feedbackRequest(contributionId, knowledgeAccuracy("accurate")), null),
    );
    expect(unauthenticated.error?.code).toBe("unauthorized");

    const withoutReceipt = await payload(
      await call(
        "feedback",
        feedbackRequest(contributionId, knowledgeAccuracy("accurate")),
        reviewer,
      ),
    );
    expect(withoutReceipt.error).toEqual({
      code: "feedback_not_eligible",
      message: "This agent is not eligible to submit feedback for this exact version.",
    });

    await retrieve(contributionId, owner);
    const contributor = await payload(
      await call("feedback", feedbackRequest(contributionId, knowledgeAccuracy("accurate")), owner),
    );
    expect(contributor).toEqual(withoutReceipt);

    const unknownVersion = await payload(
      await call(
        "feedback",
        { ...feedbackRequest(contributionId, knowledgeAccuracy("accurate")), version: 2 },
        reviewer,
      ),
    );
    expect(unknownVersion).toEqual(withoutReceipt);
  });

  it("selects the schema from the stored family and validates both assessment shapes", async () => {
    const knowledgeId = await createKnowledge();
    await retrieve(knowledgeId);

    const clientFamily = await call(
      "feedback",
      { ...feedbackRequest(knowledgeId, knowledgeAccuracy("accurate")), family: "knowledge" },
      reviewer,
    );
    expect(clientFamily.status).toBe(400);

    const wrongKnowledgeSchema = await call(
      "feedback",
      feedbackRequest(knowledgeId, validExecutionAssessment()),
      reviewer,
    );
    expect(wrongKnowledgeSchema.status).toBe(422);
    expect((await payload(wrongKnowledgeSchema)).error?.code).toBe("invalid_feedback");

    const invalidEvidence = await call(
      "feedback",
      feedbackRequest(knowledgeId, knowledgeAccuracy("accurate", "http://example.com/private")),
      reviewer,
    );
    expect(invalidEvidence.status).toBe(422);

    const oversizedAssessment = {
      accuracy: {
        finding: "mixed",
        scope: "The documented response fields",
        evidence: Array.from({ length: 9 }, (_, index) => ({
          kind: "documentation",
          uri: `https://example.com/${"a".repeat(2000)}${index}`,
        })),
      },
    };
    const overBudgetAssessment = await call(
      "feedback",
      feedbackRequest(knowledgeId, oversizedAssessment),
      reviewer,
    );
    expect(overBudgetAssessment.status).toBe(422);

    const excessReferences = await call(
      "feedback",
      feedbackRequest(knowledgeId, {
        accuracy: {
          finding: "mixed",
          scope: "The documented response fields",
          evidence: Array.from({ length: 11 }, (_, index) => ({
            kind: "documentation",
            uri: `https://example.com/accuracy-${index}`,
          })),
        },
        staleness: {
          finding: "appears_current",
          observedAt: "2026-11-15T00:00:00Z",
          evidence: Array.from({ length: 10 }, (_, index) => ({
            kind: "documentation",
            uri: `https://example.com/staleness-${index}`,
          })),
        },
      }),
      reviewer,
    );
    expect(excessReferences.status).toBe(422);

    const unsupportedNotAssessedEvidence = await call(
      "feedback",
      feedbackRequest(knowledgeId, {
        accuracy: {
          finding: "unable_to_assess",
          scope: "The documented response fields",
          evidence: [{ kind: "documentation", uri: "https://example.com/public-docs" }],
        },
      }),
      reviewer,
    );
    expect(unsupportedNotAssessedEvidence.status).toBe(422);

    const knowledgeAccepted = await call(
      "feedback",
      feedbackRequest(knowledgeId, validKnowledgeAssessment()),
      reviewer,
    );
    expect(knowledgeAccepted.status).toBe(200);
    expect((await payload(knowledgeAccepted)).schemaVersion).toBe("feedback-response/v1");

    const executionId = await createExecution();
    await retrieve(executionId);
    const wrongExecutionSchema = await call(
      "feedback",
      feedbackRequest(executionId, knowledgeAccuracy("accurate")),
      reviewer,
    );
    expect(wrongExecutionSchema.status).toBe(422);

    const invalidStep = validExecutionAssessment();
    invalidStep.outcome.steps[0] = { stepId: "not-a-stored-step", result: "passed" };
    const invalidExecution = await call(
      "feedback",
      feedbackRequest(executionId, invalidStep),
      reviewer,
    );
    expect(invalidExecution.status).toBe(422);

    const executionAccepted = await call(
      "feedback",
      feedbackRequest(executionId, validExecutionAssessment()),
      reviewer,
    );
    expect(executionAccepted.status).toBe(200);
    const stored = await db
      .prepare(
        "SELECT dimension FROM feedback_reports WHERE consumer_operator_id = ? AND contribution_id = ? ORDER BY dimension",
      )
      .bind(reviewer.operatorId, executionId)
      .all<{ dimension: string }>();
    expect(stored.results.map((row) => row.dimension)).toEqual(["compatibility", "outcome"]);
  });

  it("retries idempotently, lets the submitting agent revise, and separates operator reports", async () => {
    const contributionId = await createKnowledge();
    await retrieve(contributionId);
    const initialRequest = feedbackRequest(contributionId, knowledgeAccuracy("accurate"));

    expect((await call("feedback", initialRequest, reviewer)).status).toBe(200);
    expect((await call("feedback", initialRequest, reviewer)).status).toBe(200);

    const revisedRequest = feedbackRequest(contributionId, knowledgeAccuracy("inaccurate"));
    expect((await call("feedback", revisedRequest, reviewer)).status).toBe(200);

    await retrieve(contributionId, reviewerSibling);
    const secondAgentSameDimension = await call(
      "feedback",
      feedbackRequest(contributionId, {
        ...knowledgeAccuracy("accurate"),
        staleness: {
          finding: "not_checked",
          observedAt: "2026-11-15T00:00:00Z",
          evidence: [],
        },
      }),
      reviewerSibling,
    );
    expect(secondAgentSameDimension.status).toBe(409);
    expect((await payload(secondAgentSameDimension)).error?.code).toBe("feedback_conflict");
    const afterConflict = await db
      .prepare(
        "SELECT dimension FROM feedback_reports WHERE consumer_operator_id = ? AND contribution_id = ? ORDER BY dimension",
      )
      .bind(reviewer.operatorId, contributionId)
      .all<{ dimension: string }>();
    expect(afterConflict.results.map((row) => row.dimension)).toEqual(["accuracy"]);

    await retrieve(contributionId, otherReviewer);
    const independentReport = await call(
      "feedback",
      feedbackRequest(contributionId, knowledgeAccuracy("accurate")),
      otherReviewer,
    );
    expect(independentReport.status).toBe(200);

    const reports = await db
      .prepare(
        `SELECT consumer_operator_id, agent_id, assessment_json
           FROM feedback_reports
          WHERE contribution_id = ? AND version = 1 AND dimension = 'accuracy'
          ORDER BY consumer_operator_id`,
      )
      .bind(contributionId)
      .all<{ consumer_operator_id: string; agent_id: string; assessment_json: string }>();
    expect(reports.results).toHaveLength(2);
    expect(
      reports.results.find((report) => report.consumer_operator_id === reviewer.operatorId),
    ).toMatchObject({
      agent_id: reviewer.agentId,
      assessment_json: JSON.stringify(knowledgeAccuracy("inaccurate").accuracy),
    });
    expect(
      reports.results.find((report) => report.consumer_operator_id === otherReviewer.operatorId),
    ).toMatchObject({
      agent_id: otherReviewer.agentId,
      assessment_json: JSON.stringify(knowledgeAccuracy("accurate").accuracy),
    });
  });
});
