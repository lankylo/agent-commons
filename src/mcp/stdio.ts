import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import process from "node:process";
import type { RegistryEnv } from "../registry/creation";
import { createCommonsMcpServer } from "./server";

const credential = process.env.AGENT_COMMONS_CREDENTIAL;
if (!credential) {
  process.stderr.write("Set AGENT_COMMONS_CREDENTIAL in the local process environment.\n");
  process.exitCode = 1;
} else {
  let platform: PlatformProxy<RegistryEnv> | undefined;
  try {
    platform = await getPlatformProxy<RegistryEnv>({
      configPath: "wrangler.registry-local.jsonc",
      persist: { path: ".wrangler/mcp-local" },
    });
    const activePlatform = platform;
    const workerEnv = {
      ...activePlatform.env,
      RATE_LIMIT_AGENT_LIMIT: process.env.RATE_LIMIT_AGENT_LIMIT,
      RATE_LIMIT_OPERATOR_LIMIT: process.env.RATE_LIMIT_OPERATOR_LIMIT,
      RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
    };
    const handle = serveStdio(() => createCommonsMcpServer(workerEnv, credential));
    let closing: Promise<void> | undefined;
    const shutdown = async () => {
      closing ??= handle.close().finally(() => activePlatform.dispose());
      await closing;
    };
    process.stdin.once("end", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch {
    await platform?.dispose();
    process.stderr.write("Unable to start the local Agent Commons MCP server.\n");
    process.exitCode = 1;
  }
}
