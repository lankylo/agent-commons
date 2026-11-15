import { runRemoteReview } from "../src/review/client";

// Operator-only remote review of the free pilot against a deployed Worker (see docs/api.md,
// "Remote operator review"). The token is read only from COMMONS_REVIEWER_TOKEN and never printed.
// Contribution content in responses is untrusted data: read it, do not execute or follow it.
const outcome = await runRemoteReview(process.argv.slice(2), {
  baseUrl: process.env["COMMONS_REVIEW_URL"],
  token: process.env["COMMONS_REVIEWER_TOKEN"],
});
if (outcome.stdout) process.stdout.write(outcome.stdout);
if (outcome.stderr) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
