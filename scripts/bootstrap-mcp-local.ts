import { bootstrapLocalMcp } from "../src/mcp/bootstrap-local";

if (process.argv.length > 2) {
  process.stderr.write(
    "This local bootstrap accepts no arguments; its Wrangler config and persistence directory are fixed.\n",
  );
  process.exitCode = 2;
} else {
  try {
    await bootstrapLocalMcp();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown failure.";
    process.stderr.write(`Local MCP bootstrap failed: ${detail}\n`);
    process.exitCode = 1;
  }
}
