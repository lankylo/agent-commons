/**
 * Headless operator client for the remote review interface (`scripts/review-remote.ts`).
 * Not part of the Worker. The token is read from the environment by the caller, sent only in the
 * Authorization header and never written to output. Responses are re-serialized with
 * `JSON.stringify`, which escapes control characters in untrusted contribution text.
 */
export interface RemoteReviewConfig {
  readonly baseUrl: string | undefined;
  readonly token: string | undefined;
}

export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const REMOTE_REVIEW_USAGE = `Usage (environment: COMMONS_REVIEW_URL, COMMONS_REVIEWER_TOKEN):
  capacity
  queue [limit] [cursor]
  inspect <contributionId> <version>
  decide <contributionId> <version> <approve|reject|withdraw> <reason>
  needs [limit]
  usage
  recheck [limit]
  recheck <contributionId> <version>
  ledger
  payments
  payments <stop|start> <reason>
  payments cap <usdcBaseUnits> <reason>
  settle [limit]
  refund <purchaseRef> <reason>
  reverse <ledgerEntryId> <reason>
  validate <contributionId> <version> <note>
  unvalidate <contributionId> <version> <note>
  payouts
  payout-sent <requestId> <txHash>
  payout-reject <requestId> <reason>
  reconcile
  notify [test|now|digest]
`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type ParsedCommand = { op: string; body: Record<string, unknown> };

function parse(argv: readonly string[]): ParsedCommand | null {
  const [command, a, b, c, d, ...extra] = argv;
  if (extra.length > 0) return null;
  const version = Number(b);
  switch (command) {
    case "usage":
      return a === undefined ? { op: "usage", body: {} } : null;
    case "capacity":
      return a === undefined ? { op: "capacity", body: {} } : null;
    case "ledger":
      return a === undefined ? { op: "ledger", body: {} } : null;
    case "settle": {
      if (b !== undefined) return null;
      if (a === undefined) return { op: "settle", body: {} };
      const limit = Number(a);
      return Number.isSafeInteger(limit) ? { op: "settle", body: { limit } } : null;
    }
    case "refund":
      return a && b && c === undefined
        ? { op: "refund", body: { purchaseRef: a, reason: b } }
        : null;
    case "validate":
    case "unvalidate":
      return a && Number.isSafeInteger(version) && c && d === undefined
        ? {
            op: "validate",
            body: {
              contributionId: a,
              version,
              note: c,
              action: command === "validate" ? "validate" : "withdraw",
            },
          }
        : null;
    case "payouts":
      return a === undefined ? { op: "payouts", body: {} } : null;
    case "reconcile":
      return a === undefined ? { op: "reconcile", body: {} } : null;
    case "notify":
      if (b !== undefined) return null;
      return a === undefined || a === "test" || a === "now" || a === "digest"
        ? { op: "notify", body: { action: a ?? "test" } }
        : null;
    case "payout-sent":
    case "payout-reject": {
      const requestId = Number(a);
      if (!Number.isSafeInteger(requestId) || !b || c !== undefined) return null;
      return command === "payout-sent"
        ? { op: "payout-sent", body: { requestId, txHash: b } }
        : { op: "payout-reject", body: { requestId, reason: b } };
    }
    case "reverse": {
      const entryId = Number(a);
      return Number.isSafeInteger(entryId) && b && c === undefined
        ? { op: "reverse", body: { entryId, reason: b } }
        : null;
    }
    case "payments": {
      if (a === undefined) return { op: "payments", body: {} };
      if ((a === "stop" || a === "start") && b && c === undefined) {
        return { op: "payments", body: { action: a, reason: b } };
      }
      const capMinor = Number(b);
      return a === "cap" && Number.isSafeInteger(capMinor) && c && d === undefined
        ? { op: "payments", body: { action: "cap", capMinor, reason: c } }
        : null;
    }
    case "queue": {
      if (c !== undefined) return null;
      const body: Record<string, unknown> = {};
      if (a !== undefined) {
        const limit = Number(a);
        if (!Number.isSafeInteger(limit)) return null;
        body.limit = limit;
      }
      if (b !== undefined) body.cursor = b;
      return { op: "queue", body };
    }
    case "recheck":
      if (a !== undefined && b !== undefined) {
        return !Number.isSafeInteger(Number(a)) && Number.isSafeInteger(version) && c === undefined
          ? { op: "recheck", body: { contributionId: a, version } }
          : null;
      }
    // falls through: `recheck [limit]` is parsed like `needs [limit]`
    case "needs": {
      if (b !== undefined) return null;
      if (a === undefined) return { op: command, body: {} };
      const limit = Number(a);
      return Number.isSafeInteger(limit) ? { op: command, body: { limit } } : null;
    }
    case "inspect":
      return a && Number.isSafeInteger(version) && c === undefined
        ? { op: "inspect", body: { contributionId: a, version } }
        : null;
    case "decide":
      return a && Number.isSafeInteger(version) && c && d
        ? { op: "decide", body: { contributionId: a, version, decision: c, reason: d } }
        : null;
    default:
      return null;
  }
}

function endpoint(baseUrl: string | undefined, op: string): URL | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  return new URL(`/v1/review/${op}`, url.origin);
}

export async function runRemoteReview(
  argv: readonly string[],
  config: RemoteReviewConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CommandOutcome> {
  const request = parse(argv);
  if (!request) return { exitCode: 2, stdout: "", stderr: REMOTE_REVIEW_USAGE };
  const url = endpoint(config.baseUrl, request.op);
  if (!url) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "COMMONS_REVIEW_URL must be an https:// origin (http:// only for localhost).\n",
    };
  }
  if (!config.token) {
    return { exitCode: 2, stdout: "", stderr: "COMMONS_REVIEWER_TOKEN is not set.\n" };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
      redirect: "error",
    });
  } catch {
    return { exitCode: 1, stdout: "", stderr: "Review request failed to reach the service.\n" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Review service returned a non-JSON response (HTTP ${response.status}).\n`,
    };
  }
  const text = `${JSON.stringify(body, null, 2)}\n`;
  return response.ok
    ? { exitCode: 0, stdout: text, stderr: "" }
    : { exitCode: 1, stdout: text, stderr: `HTTP ${response.status}\n` };
}
