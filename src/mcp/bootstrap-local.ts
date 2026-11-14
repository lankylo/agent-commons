import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { CredentialService } from "../identity/credentials";
import { IdentityError, IdentityRepository } from "../identity/repository";
import type { Agent, AgentId, Operator, OperatorId } from "../identity/types";
import type { RegistryEnv } from "../registry/creation";

export const LOCAL_MCP_CONFIG_PATH = "wrangler.registry-local.jsonc";
export const LOCAL_MCP_PERSIST_DIRECTORY = ".wrangler/mcp-local";
export const LOCAL_MCP_OPERATOR_ID = "op_local_mcp_acceptance";
export const LOCAL_MCP_OPERATOR_NAME = "Agent Commons Local MCP Acceptance Test Operator";
export const LOCAL_MCP_AGENT_ID = "ag_local_mcp_acceptance";
export const LOCAL_MCP_AGENT_NAME = "Agent Commons Local MCP Acceptance Test Agent";

export const LOCAL_MCP_MIGRATION_ARGS = [
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--config",
  LOCAL_MCP_CONFIG_PATH,
  "--persist-to",
  LOCAL_MCP_PERSIST_DIRECTORY,
] as const;

interface LocalDatabase {
  readonly DB: D1Database;
  dispose(): Promise<void>;
}

export interface LocalMcpBootstrapAdapters {
  readonly applyMigrations: (args: readonly string[]) => void;
  readonly openDatabase: (configPath: string, persistDirectory: string) => Promise<LocalDatabase>;
  readonly writeStdout: (message: string) => void;
}

const defaultAdapters: LocalMcpBootstrapAdapters = {
  applyMigrations: (args) => {
    execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
  },
  openDatabase: (_configPath, persistDirectory) => openLocalMcpDatabase(persistDirectory),
  writeStdout: (message) => {
    process.stdout.write(message);
  },
};

export function openLocalMcpPlatform(
  persistDirectory: string = LOCAL_MCP_PERSIST_DIRECTORY,
): Promise<PlatformProxy<RegistryEnv>> {
  return getPlatformProxy<RegistryEnv>({
    configPath: LOCAL_MCP_CONFIG_PATH,
    remoteBindings: false,
    persist: { path: join(persistDirectory, "v3") },
  });
}

export async function openLocalMcpDatabase(persistDirectory: string): Promise<LocalDatabase> {
  const platform = await openLocalMcpPlatform(persistDirectory);
  return { DB: platform.env.DB, dispose: () => platform.dispose() };
}

function assertOperatorFixture(operator: Operator): void {
  if (
    operator.id !== LOCAL_MCP_OPERATOR_ID ||
    operator.displayName !== LOCAL_MCP_OPERATOR_NAME ||
    operator.kind !== "organization" ||
    operator.status !== "active"
  ) {
    throw new Error("The reserved local MCP acceptance operator ID is already in use.");
  }
}

function assertAgentFixture(agent: Agent, operatorId: OperatorId): void {
  if (
    agent.id !== LOCAL_MCP_AGENT_ID ||
    agent.displayName !== LOCAL_MCP_AGENT_NAME ||
    agent.operatorId !== operatorId ||
    agent.status !== "active"
  ) {
    throw new Error("The reserved local MCP acceptance agent ID is already in use.");
  }
}

async function createOrReuseOperator(identity: IdentityRepository): Promise<Operator> {
  const operatorId = LOCAL_MCP_OPERATOR_ID as OperatorId;
  const existing = await identity.getOperator(operatorId);
  if (existing) {
    assertOperatorFixture(existing);
    return existing;
  }

  try {
    return await identity.createOperator({
      kind: "organization",
      displayName: LOCAL_MCP_OPERATOR_NAME,
    });
  } catch (error) {
    if (!(error instanceof IdentityError) || error.code !== "duplicate_identity") throw error;
    const raced = await identity.getOperator(operatorId);
    if (!raced) throw error;
    assertOperatorFixture(raced);
    return raced;
  }
}

async function createOrReuseAgent(
  identity: IdentityRepository,
  operatorId: OperatorId,
): Promise<Agent> {
  const agentId = LOCAL_MCP_AGENT_ID as AgentId;
  const existing = await identity.getAgent(agentId);
  if (existing) {
    assertAgentFixture(existing, operatorId);
    return existing;
  }

  try {
    return await identity.registerAgent(operatorId, { displayName: LOCAL_MCP_AGENT_NAME });
  } catch (error) {
    if (!(error instanceof IdentityError) || error.code !== "duplicate_identity") throw error;
    const raced = await identity.getAgent(agentId);
    if (!raced) throw error;
    assertAgentFixture(raced, operatorId);
    return raced;
  }
}

function credentialOutput(token: string, credentialId: string): string {
  return [
    "Agent Commons local MCP acceptance fixture is ready.",
    "Copy this credential into the MCP host's private process environment as AGENT_COMMONS_CREDENTIAL.",
    "The credential is shown only once and cannot be recovered. Every rerun issues a new credential.",
    `Credential ID (non-secret; retain to revoke): ${credentialId}`,
    "Lost credentials remain revocable through CredentialService.revokeCredential using their credential ID.",
    `AGENT_COMMONS_CREDENTIAL=${token}`,
    "",
  ].join("\n");
}

export async function bootstrapLocalMcp(
  adapters: LocalMcpBootstrapAdapters = defaultAdapters,
): Promise<void> {
  adapters.applyMigrations(LOCAL_MCP_MIGRATION_ARGS);
  const local = await adapters.openDatabase(LOCAL_MCP_CONFIG_PATH, LOCAL_MCP_PERSIST_DIRECTORY);
  try {
    const identity = new IdentityRepository(local.DB, {
      newId: (prefix) => (prefix === "op" ? LOCAL_MCP_OPERATOR_ID : LOCAL_MCP_AGENT_ID),
    });
    const operator = await createOrReuseOperator(identity);

    await local.DB.prepare(
      "UPDATE operators SET contribution_allow_listed = 1 WHERE id = ? AND status = 'active'",
    )
      .bind(operator.id)
      .run();
    const allowListedOperator = await identity.getOperator(operator.id);
    if (!allowListedOperator?.contributionAllowListed) {
      throw new Error("The local MCP acceptance operator could not be allow-listed.");
    }

    const agent = await createOrReuseAgent(identity, operator.id);
    const issued = await new CredentialService(local.DB).issueCredential(agent.id, {
      label: "local-mcp-acceptance",
    });
    adapters.writeStdout(credentialOutput(issued.token, issued.credential.id));
  } finally {
    await local.dispose();
  }
}
