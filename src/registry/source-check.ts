/**
 * Deterministic Knowledge source re-checks (Phase 5, platform-only).
 *
 * For each source of a listed Knowledge version the platform fetches the recorded URI, hashes the
 * response body with SHA-256 and compares it with the hash stored on the immutable version. Each
 * result is appended to `source_checks`; nothing is ever fetched on an agent's request. A check
 * never changes a version's listing state: it only feeds the derived trust summary.
 *
 * Fetch rules: HTTPS only, no redirects followed, a bounded body and a timeout. A GitHub `blob`
 * page is fetched as its raw file, because the page HTML is not stable between requests while the
 * file at a pinned commit is. Anything other than a complete `200` body is `unreachable`.
 * Outcomes: `match`, `mismatch` (a body was read and its hash differs) or `unreachable`.
 */
import { TrustStore } from "./trust";

export const SOURCE_CHECK_LIMITS = {
  /** Sources checked per run; keeps one run well inside Worker subrequest limits. */
  maxPerRun: 15,
  /** A source is due again this many days after its latest check. */
  minIntervalDays: 7,
  maxBodyBytes: 2_000_000,
  timeoutMs: 10_000,
} as const;

export type SourceCheckOutcome = "match" | "mismatch" | "unreachable";

export type SourceFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface SourceCheckRun {
  readonly schemaVersion: "source-recheck/v1";
  readonly checkedAt: string;
  readonly checked: number;
  readonly match: number;
  readonly mismatch: number;
  readonly unreachable: number;
  /** Sources still due after this run; run again to continue. */
  readonly remainingDue: number;
}

const GITHUB_BLOB = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

/** The URL actually fetched for a recorded source URI, or null when it must not be fetched. */
export function sourceFetchUrl(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname === "github.com") {
    const blob = GITHUB_BLOB.exec(url.pathname);
    if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  url.hash = "";
  return url.toString();
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface FetchedSource {
  readonly httpStatus: number | null;
  /** SHA-256 of the complete body, or null when no complete `200` body was read. */
  readonly digest: string | null;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchSource(fetcher: SourceFetcher, url: string): Promise<FetchedSource> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "agent-commons-source-check/1" },
      signal: AbortSignal.timeout(SOURCE_CHECK_LIMITS.timeoutMs),
    });
    const status = response.status;
    const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    if (status !== 200) {
      await response.body?.cancel();
      return { httpStatus, digest: null };
    }
    const body = await readBounded(response, SOURCE_CHECK_LIMITS.maxBodyBytes);
    if (!body) return { httpStatus, digest: null };
    return { httpStatus, digest: toHex(await crypto.subtle.digest("SHA-256", body)) };
  } catch {
    return { httpStatus: null, digest: null };
  }
}

function outcomeOf(digest: string | null, expected: string): SourceCheckOutcome {
  if (digest === null) return "unreachable";
  return digest === expected ? "match" : "mismatch";
}

interface DueSource {
  contribution_id: string;
  version: number;
  ordinal: number;
  uri: string;
  hash_digest: string;
}

/** ?1 cutoff timestamp: sources never checked, or last checked at or before it, are due. */
const DUE_FROM = `FROM (
    SELECT ks.contribution_id, ks.version, ks.ordinal, ks.uri, ks.hash_digest,
           (SELECT MAX(sc.checked_at) FROM source_checks sc
             WHERE sc.contribution_id = ks.contribution_id AND sc.version = ks.version
               AND sc.ordinal = ks.ordinal) AS last_checked
      FROM knowledge_sources ks
      JOIN version_quality_states q
        ON q.contribution_id = ks.contribution_id AND q.version = ks.version
       AND q.state = 'listed_unverified'
  ) due
 WHERE due.last_checked IS NULL OR due.last_checked <= ?1`;

const DUE_SQL = `SELECT due.contribution_id, due.version, due.ordinal, due.uri, due.hash_digest
  ${DUE_FROM}
 ORDER BY due.last_checked IS NOT NULL, due.last_checked, due.contribution_id, due.version,
          due.ordinal
 LIMIT ?2`;

const DUE_COUNT_SQL = `SELECT COUNT(*) AS n ${DUE_FROM}`;

const INSERT_SQL = `INSERT INTO source_checks
  (contribution_id, version, ordinal, checked_at, outcome, http_status, observed_digest)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

export class SourceChecker {
  private readonly now: () => Date;
  private readonly fetcher: SourceFetcher;

  constructor(
    private readonly db: D1Database,
    options: { readonly now?: () => Date; readonly fetcher?: SourceFetcher } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  }

  /** Checks up to `limit` due sources, records each result and refreshes derived trust. */
  async run(limit: number = SOURCE_CHECK_LIMITS.maxPerRun): Promise<SourceCheckRun> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_CHECK_LIMITS.maxPerRun) {
      throw new RangeError("invalid source check limit");
    }
    const checkedAt = this.now().toISOString();
    const intervalMs = SOURCE_CHECK_LIMITS.minIntervalDays * 86_400_000;
    const cutoff = new Date(this.now().getTime() - intervalMs).toISOString();
    const due = await this.db.prepare(DUE_SQL).bind(cutoff, limit).all<DueSource>();

    const counts = { match: 0, mismatch: 0, unreachable: 0 };
    const fetched = new Map<string, Promise<FetchedSource>>();
    const inserts: D1PreparedStatement[] = [];
    const insert = this.db.prepare(INSERT_SQL);
    for (const source of due.results) {
      const url = sourceFetchUrl(source.uri);
      let result: FetchedSource = { httpStatus: null, digest: null };
      if (url) {
        // One fetch per distinct URL in a run, however many versions cite it.
        const pending = fetched.get(url) ?? fetchSource(this.fetcher, url);
        fetched.set(url, pending);
        result = await pending;
      }
      const { httpStatus, digest } = result;
      const outcome = outcomeOf(digest, source.hash_digest);
      counts[outcome] += 1;
      const { contribution_id: id, version, ordinal } = source;
      inserts.push(insert.bind(id, version, ordinal, checkedAt, outcome, httpStatus, digest));
    }
    if (inserts.length > 0) {
      await this.db.batch(inserts);
      await new TrustStore(this.db, this.now).refresh();
    }
    const remaining = await this.db.prepare(DUE_COUNT_SQL).bind(cutoff).first<{ n: number }>();
    return {
      schemaVersion: "source-recheck/v1",
      checkedAt,
      checked: inserts.length,
      ...counts,
      remainingDue: remaining?.n ?? 0,
    };
  }
}
