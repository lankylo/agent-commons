// Opt-in live check: `npm run seed:verify:httpbin`. Makes ONE read-only GET to httpbin.org.
import { HTTPBIN_SEED_URL, verifyHttpbinLive } from "../src/seed/httpbin-live-check.ts";

const r = await verifyHttpbinLive();
if (r.ok) {
  console.log(`PASS ${r.verifiedAt} GET ${HTTPBIN_SEED_URL}: HTTP 200, args.agent_commons=seed-v1`);
} else {
  console.error(`FAIL (${r.kind}) ${r.verifiedAt}: ${r.message}`);
  process.exit(1);
}
