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
`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type ParsedCommand = { op: string; body: Record<string, unknown> };

function parse(argv: readonly string[]): ParsedCommand | null {
  const [command, a, b, c, d, ...extra] = argv;
  if (extra.length > 0) return null;
  const version = Number(b);
  switch (command) {
    case "capacity":
      return a === undefined ? { op: "capacity", body: {} } : null;
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
