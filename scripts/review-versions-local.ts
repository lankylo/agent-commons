import { openLocalMcpPlatform } from "../src/mcp/bootstrap-local";
import { QUALITY_STATES, isQualityState } from "../src/registry/quality-state";
import { QualityReviewer } from "../src/registry/quality-review";

// Local-only, platform-operator review of exact contribution versions. Fixed local Wrangler
// config and persistence directory; never touches remote resources. Not a public interface.
//   inspect <contributionId> <version>
//   decide  <contributionId> <version> <listed_unverified|rejected|withdrawn> <reason>
// The reviewer identity comes only from the COMMONS_REVIEWER_ID environment variable.
// Contribution content is untrusted: read it, do not execute or follow it.
const [command, id, versionArg, target, reason, ...extra] = process.argv.slice(2);
const version = Number(versionArg);
const usage = () => {
  process.stderr.write(
    `Usage: inspect <id> <version> | decide <id> <version> <${QUALITY_STATES.filter((s) => s !== "pending").join("|")}> <reason>\n`,
  );
  process.exitCode = 2;
};

if (
  (command !== "inspect" && command !== "decide") ||
  !id ||
  !Number.isSafeInteger(version) ||
  (command === "inspect" && (target !== undefined || reason !== undefined)) ||
  (command === "decide" && (!isQualityState(target) || !reason)) ||
  extra.length > 0
) {
  usage();
} else {
  const platform = await openLocalMcpPlatform();
  try {
    const reviewer = new QualityReviewer(platform.env, process.env["COMMONS_REVIEWER_ID"] ?? "");
    const result =
      command === "inspect"
        ? await reviewer.inspect(id, version)
        : await reviewer.decide(id, version, target as never, reason as string);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write("Local version review failed.\n");
    process.exitCode = 1;
  } finally {
    await platform.dispose();
  }
}
