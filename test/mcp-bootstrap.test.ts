import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  bootstrapLocalMcp,
  openLocalMcpDatabase,
  LOCAL_MCP_AGENT_ID,
  LOCAL_MCP_AGENT_NAME,
  LOCAL_MCP_CONFIG_PATH,
  LOCAL_MCP_MIGRATION_ARGS,
  LOCAL_MCP_OPERATOR_ID,
  LOCAL_MCP_OPERATOR_NAME,
  LOCAL_MCP_PERSIST_DIRECTORY,
  type LocalMcpBootstrapAdapters,
} from "../src/mcp/bootstrap-local";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "commons-mcp-bootstrap-"));
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
      LOCAL_MCP_CONFIG_PATH,
      "--persist-to",
      dir,
    ],
    { stdio: "pipe" },
  );
  proxy = await getPlatformProxy<RegistryEnv>({
    configPath: LOCAL_MCP_CONFIG_PATH,
    persist: { path: join(dir, "v3") },
  });
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

describe("local MCP bootstrap", () => {
  it("opens a temporary database migrated by Wrangler through the real adapter", async () => {
    const temporaryPersistence = mkdtempSync(join(tmpdir(), "commons-mcp-wrangler-path-"));
    try {
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
          LOCAL_MCP_CONFIG_PATH,
          "--persist-to",
          temporaryPersistence,
        ],
        { stdio: "pipe" },
      );

      const local = await openLocalMcpDatabase(temporaryPersistence);
      try {
        const table = await local.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operators'",
        ).first<{ name: string }>();
        expect(table?.name).toBe("operators");
      } finally {
        await local.dispose();
      }
    } finally {
      rmSync(temporaryPersistence, { recursive: true, force: true });
    }
  }, 180_000);

  it("uses only the fixed local config and safely reuses the allow-listed fixture", async () => {
    const migrationCalls: string[][] = [];
    const outputs: string[] = [];
    const adapters: LocalMcpBootstrapAdapters = {
      applyMigrations: (args) => migrationCalls.push([...args]),
      openDatabase: async (configPath, persistDirectory) => {
        expect(configPath).toBe(LOCAL_MCP_CONFIG_PATH);
        expect(persistDirectory).toBe(LOCAL_MCP_PERSIST_DIRECTORY);
        return { DB: proxy.env.DB, dispose: async () => {} };
      },
      writeStdout: (message) => outputs.push(message),
    };
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      await bootstrapLocalMcp(adapters);
      const firstOutput = outputs[0]!;
      const firstToken = firstOutput.match(/AGENT_COMMONS_CREDENTIAL=(\S+)/)?.[1];
      expect(firstToken).toMatch(/^ac1_[0-9a-f]{24}_[0-9a-f]{64}$/);
      expect(firstOutput.split(firstToken!).length - 1).toBe(1);
      expect(firstOutput).toContain("private process environment");
      expect(firstOutput).toContain("shown only once");
      expect(firstOutput).toContain("CredentialService.revokeCredential");
      expect(firstOutput).toContain(
        `Credential ID (non-secret; retain to revoke): ${firstToken!.split("_")[1]}`,
      );

      const operatorBefore = await new IdentityRepository(proxy.env.DB).getOperator(
        LOCAL_MCP_OPERATOR_ID as OperatorId,
      );
      const agentBefore = await new IdentityRepository(proxy.env.DB).getAgent(
        LOCAL_MCP_AGENT_ID as AgentId,
      );
      expect(operatorBefore).toMatchObject({
        displayName: LOCAL_MCP_OPERATOR_NAME,
        contributionAllowListed: true,
        status: "active",
      });
      expect(agentBefore).toMatchObject({
        displayName: LOCAL_MCP_AGENT_NAME,
        operatorId: LOCAL_MCP_OPERATOR_ID,
        status: "active",
      });

      await proxy.env.DB.prepare("UPDATE operators SET contribution_allow_listed = 0 WHERE id = ?")
        .bind(LOCAL_MCP_OPERATOR_ID)
        .run();
      await bootstrapLocalMcp(adapters);
      const secondOutput = outputs[1]!;
      const secondToken = secondOutput.match(/AGENT_COMMONS_CREDENTIAL=(\S+)/)?.[1];
      expect(secondToken).toMatch(/^ac1_[0-9a-f]{24}_[0-9a-f]{64}$/);
      expect(secondToken).not.toBe(firstToken);
      expect(secondOutput.split(secondToken!).length - 1).toBe(1);
      expect(outputs).toHaveLength(2);
      expect(migrationCalls).toEqual([LOCAL_MCP_MIGRATION_ARGS, LOCAL_MCP_MIGRATION_ARGS]);
      expect(LOCAL_MCP_MIGRATION_ARGS).toContain("--local");
      expect(LOCAL_MCP_MIGRATION_ARGS).toContain("wrangler.registry-local.jsonc");
      expect(LOCAL_MCP_MIGRATION_ARGS).toContain(".wrangler/mcp-local");

      const identity = new IdentityRepository(proxy.env.DB);
      expect(await identity.getOperator(LOCAL_MCP_OPERATOR_ID as OperatorId)).toMatchObject({
        contributionAllowListed: true,
      });
      expect(await identity.getAgent(LOCAL_MCP_AGENT_ID as AgentId)).toMatchObject({
        operatorId: LOCAL_MCP_OPERATOR_ID,
      });
      const operatorCount = await proxy.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operators WHERE id = ?",
      )
        .bind(LOCAL_MCP_OPERATOR_ID)
        .first<{ count: number }>();
      const agentCount = await proxy.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM agents WHERE id = ?",
      )
        .bind(LOCAL_MCP_AGENT_ID)
        .first<{ count: number }>();
      expect(operatorCount?.count).toBe(1);
      expect(agentCount?.count).toBe(1);

      const credentialService = new CredentialService(proxy.env.DB);
      const firstVerification = await credentialService.verifyCredential(firstToken);
      const secondVerification = await credentialService.verifyCredential(secondToken);
      expect(firstVerification.ok).toBe(true);
      expect(secondVerification.ok).toBe(true);
      if (!firstVerification.ok) throw new Error("Expected first credential to remain active.");
      await credentialService.revokeCredential(firstVerification.credentialId);
      expect(await credentialService.verifyCredential(firstToken)).toMatchObject({
        ok: false,
        reason: "revoked",
      });

      const credentials = await proxy.env.DB.prepare(
        "SELECT secret_digest FROM agent_credentials",
      ).all<{ secret_digest: string }>();
      const stored = JSON.stringify(credentials.results);
      expect(stored).not.toContain(firstToken);
      expect(stored).not.toContain(secondToken);
      expect(credentials.results).toHaveLength(2);
      expect(
        credentials.results.every(({ secret_digest }) => /^[0-9a-f]{64}$/.test(secret_digest)),
      ).toBe(true);

      const files = listFiles(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = readFileSync(file).toString("utf8");
        expect(content).not.toContain(firstToken);
        expect(content).not.toContain(secondToken);
      }
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();

      await proxy.env.DB.prepare(
        "UPDATE agents SET display_name = 'Unrelated identity' WHERE id = ?",
      )
        .bind(LOCAL_MCP_AGENT_ID)
        .run();
      await expect(bootstrapLocalMcp(adapters)).rejects.toThrow(
        "The reserved local MCP acceptance agent ID is already in use.",
      );
      expect(outputs).toHaveLength(2);
      await proxy.env.DB.prepare("UPDATE agents SET display_name = ? WHERE id = ?")
        .bind(LOCAL_MCP_AGENT_NAME, LOCAL_MCP_AGENT_ID)
        .run();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("refuses configuration arguments before running the bootstrap", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bootstrap-mcp-local.ts", "--config", "remote.jsonc"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("accepts no arguments");
    expect(result.stdout).toBe("");
  });
});
