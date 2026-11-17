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
 * file at a pinned commit is. When that URI ends in a line anchor (`#L10` or `#L10-L20`), only
 * those lines are hashed, each with its newline, exactly as `sed -n '10,20p'` prints them.
 * Anything other than a complete `200` body is `unreachable`.
 * Outcomes: `match`, `mismatch` (a body was read and its hash differs) or `unreachable`.
 */
import { TrustStore, type VersionRef } from "./trust";

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

/** What is fetched for a recorded source URI, and which lines of it are hashed. */
export interface SourceFetchTarget {
  readonly url: string;
  /** Inclusive 1-based line range, or null to hash the whole body. */
  readonly lines: readonly [number, number] | null;
}

const GITHUB_BLOB = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/;
const LINE_ANCHOR = /^#L(\d{1,7})(?:-L(\d{1,7}))?$/;

function lineRange(hash: string): readonly [number, number] | null {
  const anchor = LINE_ANCHOR.exec(hash);
  if (!anchor) return null;
  const start = Number(anchor[1]);
  const end = anchor[2] === undefined ? start : Number(anchor[2]);
  return start >= 1 && end >= start ? [start, end] : null;
}

/** The fetch target for a recorded source URI, or null when it must not be fetched. */
export function sourceFetchTarget(uri: string): SourceFetchTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname === "github.com") {
    const blob = GITHUB_BLOB.exec(url.pathname);
    if (blob) {
      return {
        url: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`,
        lines: lineRange(url.hash),
      };
    }
  }
  url.hash = "";
  return { url: url.toString(), lines: null };
}

/** The URL actually fetched for a recorded source URI, or null when it must not be fetched. */
export function sourceFetchUrl(uri: string): string | null {
  return sourceFetchTarget(uri)?.url ?? null;
}

/**
 * Lines `start` to `end` (1-based, inclusive) of a body split on LF. Each selected line keeps its
 * LF, and a final line without one gains one, as `sed -n 'start,endp'` prints them. Lines past the
 * end of the body are simply absent.
 */
export function selectLines(body: Uint8Array, start: number, end: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let line = 1;
  let from = 0;
  for (let i = 0; i <= body.length && line <= end; i++) {
    if (i < body.length && body[i] !== 0x0a) continue;
    if (i === body.length && from === i) break;
    if (line >= start) parts.push(body.subarray(from, i));
    line += 1;
    from = i + 1;
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length + 1, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    out[offset + part.length] = 0x0a;
    offset += part.length + 1;
  }
  return out;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface FetchedBody {
  readonly httpStatus: number | null;
  /** The complete body, or null when no complete `200` body was read. */
  readonly body: Uint8Array | null;
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

async function fetchBody(fetcher: SourceFetcher, url: string): Promise<FetchedBody> {
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
      return { httpStatus, body: null };
    }
    return { httpStatus, body: await readBounded(response, SOURCE_CHECK_LIMITS.maxBodyBytes) };
  } catch {
    return { httpStatus: null, body: null };
  }
}

async function digestOf(body: Uint8Array, lines: SourceFetchTarget["lines"]): Promise<string> {
  const hashed = lines ? selectLines(body, lines[0], lines[1]) : body;
  return toHex(await crypto.subtle.digest("SHA-256", hashed));
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

const LISTED_SOURCES = `(
    SELECT ks.contribution_id, ks.version, ks.ordinal, ks.uri, ks.hash_digest,
           (SELECT MAX(sc.checked_at) FROM source_checks sc
             WHERE sc.contribution_id = ks.contribution_id AND sc.version = ks.version
               AND sc.ordinal = ks.ordinal) AS last_checked
      FROM knowledge_sources ks
      JOIN version_quality_states q
        ON q.contribution_id = ks.contribution_id AND q.version = ks.version
       AND q.state = 'listed_unverified'
  ) due`;

/** ?1 cutoff: sources never checked, or last checked at or before it, are due. */
const IS_DUE = "(due.last_checked IS NULL OR due.last_checked <= ?1)";

/**
 * ?1 cutoff, ?2 limit, ?3 contribution ID or NULL, ?4 version. With a target, every source of that
 * exact version is selected whether or not it is due; otherwise only due sources are.
 */
const DUE_SQL = `SELECT due.contribution_id, due.version, due.ordinal, due.uri, due.hash_digest
  FROM ${LISTED_SOURCES}
 WHERE (?3 IS NULL AND ${IS_DUE}) OR (due.contribution_id = ?3 AND due.version = ?4)
 ORDER BY due.last_checked IS NOT NULL, due.last_checked, due.contribution_id, due.version,
          due.ordinal
 LIMIT ?2`;

const DUE_COUNT_SQL = `SELECT COUNT(*) AS n FROM ${LISTED_SOURCES} WHERE ${IS_DUE}`;

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

  /**
   * Checks up to `limit` due sources, records each result and refreshes derived trust. With a
   * `target`, checks every source of that exact listed version now, even if none is due.
   */
  async run(
    limit: number = SOURCE_CHECK_LIMITS.maxPerRun,
    target?: VersionRef,
  ): Promise<SourceCheckRun> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_CHECK_LIMITS.maxPerRun) {
      throw new RangeError("invalid source check limit");
    }
    const checkedAt = this.now().toISOString();
    const intervalMs = SOURCE_CHECK_LIMITS.minIntervalDays * 86_400_000;
    const cutoff = new Date(this.now().getTime() - intervalMs).toISOString();
    const due = await this.db
      .prepare(DUE_SQL)
      .bind(cutoff, limit, target?.id ?? null, target?.version ?? null)
      .all<DueSource>();

    const counts = { match: 0, mismatch: 0, unreachable: 0 };
    const fetched = new Map<string, Promise<FetchedBody>>();
    const inserts: D1PreparedStatement[] = [];
    const insert = this.db.prepare(INSERT_SQL);
    for (const source of due.results) {
      const fetchTarget = sourceFetchTarget(source.uri);
      let httpStatus: number | null = null;
      let digest: string | null = null;
      if (fetchTarget) {
        // One fetch per distinct URL in a run, however many versions or line ranges cite it.
        const pending = fetched.get(fetchTarget.url) ?? fetchBody(this.fetcher, fetchTarget.url);
        fetched.set(fetchTarget.url, pending);
        const result = await pending;
        httpStatus = result.httpStatus;
        if (result.body) digest = await digestOf(result.body, fetchTarget.lines);
      }
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
