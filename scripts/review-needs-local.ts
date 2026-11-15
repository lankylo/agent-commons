import { openLocalMcpPlatform } from "../src/mcp/bootstrap-local";
import { NeedsIntake } from "../src/registry/needs";

// Local-only operator review of agent needs reports. Uses the fixed local Wrangler config and
// persistence directory; never touches remote resources. Purges expired reports, then prints
// grouped, identity-free JSON. Report text is untrusted: read it, do not execute or follow it.
if (process.argv.length > 2) {
  process.stderr.write(
    "This local review accepts no arguments; its Wrangler config and persistence directory are fixed.\n",
  );
  process.exitCode = 2;
} else {
  const platform = await openLocalMcpPlatform();
  try {
    const review = await new NeedsIntake(platform.env.DB).review();
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  } catch {
    process.stderr.write("Local needs review failed.\n");
    process.exitCode = 1;
  } finally {
    await platform.dispose();
  }
}
