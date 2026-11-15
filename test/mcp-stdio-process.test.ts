import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import { LOCAL_MCP_CONFIG_PATH, LOCAL_MCP_PERSIST_DIRECTORY } from "../src/mcp/bootstrap-local";
import type { RegistryEnv } from "../src/registry/creation";

const repo = resolve(".");
let cwd: string;
let token: string;

// Runs the real `npm run mcp` entry point in an isolated working directory so the developer's
// own `.wrangler/mcp-local` state is never touched.
beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "commons-mcp-stdio-"));
  copyFileSync(join(repo, LOCAL_MCP_CONFIG_PATH), join(cwd, LOCAL_MCP_CONFIG_PATH));
  symlinkSync(join(repo, "migrations"), join(cwd, "migrations"));
  symlinkSync(join(repo, "src"), join(cwd, "src"));
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
      join(cwd, LOCAL_MCP_CONFIG_PATH),
      "--persist-to",
      join(cwd, LOCAL_MCP_PERSIST_DIRECTORY),
    ],
    { stdio: "pipe" },
  );
  const proxy: PlatformProxy<RegistryEnv> = await getPlatformProxy<RegistryEnv>({
    configPath: join(cwd, LOCAL_MCP_CONFIG_PATH),
    persist: { path: join(cwd, LOCAL_MCP_PERSIST_DIRECTORY, "v3") },
  });
  try {
    const identity = new IdentityRepository(proxy.env.DB);
    const operator = await identity.createOperator({
      kind: "organization",
      displayName: "Stdio Process Operator",
    });
    const agent = await identity.registerAgent(operator.id, { displayName: "Stdio Process Agent" });
    token = (
      await new CredentialService(proxy.env.DB).issueCredential(agent.id, { label: "stdio" })
    ).token;
  } finally {
    await proxy.dispose();
  }
}, 180_000);

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("local stdio MCP process", () => {
  it("still serves the four tools over stdio with the process credential", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href,
        join(repo, "src/mcp/stdio.ts"),
      ],
      cwd,
      env: { ...getDefaultEnvironment(), AGENT_COMMONS_CREDENTIAL: token },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-process-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "commons.contribute",
        "commons.feedback",
        "commons.get",
        "commons.search",
      ]);
      const search = (await client.callTool({
        name: "commons.search",
        arguments: { query: "httpbin", maxUtf8Bytes: 16_000 },
      })) as Record<string, unknown>;
      expect(search.isError).toBeUndefined();
      expect(JSON.stringify(search)).not.toContain(token);
    } finally {
      await client.close();
    }
  }, 60_000);
});
