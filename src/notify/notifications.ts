/**
 * What the owner is told, and when (owner request 2026-11-19).
 *
 * - Every run of the frequent cron (`NOTIFY_CRON`) announces new items once: work waiting for the
 *   owner (manual payouts to send, Execution records to validate, contributions to review) and
 *   activity (external verifications, outcome and accuracy reports, payout requests, deposits, new
 *   operators, needs reports). Items are recorded in `notifications_sent` only after delivery, so a
 *   failed delivery is retried on the next run.
 * - The daily cron sends a summary: activity since the previous UTC day, what is still waiting for
 *   the owner, and the reconciliation result.
 *
 * On the very first run, existing activity is recorded without being announced; work waiting for
 * the owner is always announced. Messages carry public IDs, titles, amounts and wallet addresses
 * only: never credentials, content or feedback text.
 */
import { formatUsdc } from "../enrollment/spending";
import type { ReconciliationReport } from "../payments/reconcile";
import { clip, MAX_MESSAGE_CHARS, telegramOf, type NotifyEnv } from "./telegram";

/** The frequent cron; configure it next to the daily one in `triggers.crons`. */
export const NOTIFY_CRON = "*/15 * * * *";

type Row = Record<string, string | number | null>;

interface Source {
  readonly kind: string;
  readonly title: string;
  /** Work for the owner: announced even on the first run. */
  readonly actionable: boolean;
  readonly sql: string;
  readonly line: (row: Row) => string;
}

const LIMIT = 100;
const SECTION_LINES = 10;
const LINE_CHARS = 300;

const notSent = (kind: string, ref: string) =>
  `NOT EXISTS (SELECT 1 FROM notifications_sent n WHERE n.kind = '${kind}' AND n.ref = ${ref})`;
const VERSION_REF = "v.contribution_id || ':' || v.version";
const LATEST_VALIDATION = `COALESCE((SELECT p.action FROM platform_validations p
  WHERE p.contribution_id = v.contribution_id AND p.version = v.version
  ORDER BY p.validation_id DESC LIMIT 1), '')`;
const VALIDATION_DUE = `v.family = 'execution' AND q.state = 'listed_unverified'
  AND ${LATEST_VALIDATION} <> 'validate'`;
const APPROVED_UNSENT = `EXISTS (SELECT 1 FROM payout_events e
    WHERE e.request_id = r.request_id AND e.event = 'approved')
  AND NOT EXISTS (SELECT 1 FROM payout_events e
    WHERE e.request_id = r.request_id AND e.event IN ('rejected','cancelled','sent'))`;
const AWAITING_APPROVAL =
  "NOT EXISTS (SELECT 1 FROM payout_events e WHERE e.request_id = r.request_id)";
const FINDING = "COALESCE(json_extract(f.assessment_json, '$.finding'), 'unknown')";
const REPORT_REF = `f.consumer_operator_id || ':' || f.contribution_id || ':' || f.version
  || ':' || f.dimension || ':' || ${FINDING}`;
const VERSIONS_WITH_STATE = `contribution_versions v JOIN version_quality_states q
  ON q.contribution_id = v.contribution_id AND q.version = v.version`;

const usdc = (units: unknown) => `${formatUsdc(Number(units))} USDC`;

/** In the order the sections appear: the owner's work first. */
export const SOURCES: readonly Source[] = [
  {
    kind: "payout_due",
    title: "Manual payments due from you",
    actionable: true,
    sql: `SELECT CAST(r.request_id AS TEXT) AS ref, r.request_id AS id, r.amount_minor AS amount,
            r.destination AS destination
          FROM payout_requests r
          WHERE ${APPROVED_UNSENT} AND ${notSent("payout_due", "CAST(r.request_id AS TEXT)")}
          ORDER BY r.request_id LIMIT ${LIMIT}`,
    line: (r) =>
      `#${r.id}: send ${usdc(r.amount)} to ${r.destination}, then run: payout-sent ${r.id} <txHash>`,
  },
  {
    kind: "validation_due",
    title: "Execution records waiting for your validation",
    actionable: true,
    sql: `SELECT ${VERSION_REF} AS ref, v.contribution_id AS id, v.version AS version, v.title AS title
          FROM ${VERSIONS_WITH_STATE}
          WHERE ${VALIDATION_DUE} AND ${notSent("validation_due", VERSION_REF)}
          ORDER BY v.created_at LIMIT ${LIMIT}`,
    line: (r) => `${r.title}: validate ${r.id} ${r.version} "<note>"`,
  },
  {
    kind: "review_due",
    title: "Contributions waiting for your review",
    actionable: true,
    sql: `SELECT ${VERSION_REF} AS ref, v.contribution_id AS id, v.version AS version,
            v.family AS family, v.title AS title
          FROM ${VERSIONS_WITH_STATE}
          WHERE q.state = 'pending' AND ${notSent("review_due", VERSION_REF)}
          ORDER BY v.created_at LIMIT ${LIMIT}`,
    line: (r) => `${r.family}: ${r.title}: inspect ${r.id} ${r.version}`,
  },
  {
    kind: "verified_externally",
    title: "Verified by an external operator",
    actionable: false,
    sql: `SELECT CAST(l.entry_id AS TEXT) AS ref, v.title AS title, l.operator_id AS operator,
            l.amount_minor AS amount
          FROM ledger_entries l JOIN contribution_versions v
            ON v.contribution_id = l.contribution_id AND v.version = l.version
          WHERE l.entry_type = 'task_earning'
            AND ${notSent("verified_externally", "CAST(l.entry_id AS TEXT)")}
          ORDER BY l.entry_id LIMIT ${LIMIT}`,
    line: (r) =>
      `${r.title}: verified by operator ${r.operator}; reward ${usdc(r.amount)} pending (7-day hold)`,
  },
  {
    kind: "report",
    title: "New outcome and accuracy reports",
    actionable: false,
    sql: `SELECT ${REPORT_REF} AS ref, v.title AS title, v.version AS version,
            f.dimension AS dimension, ${FINDING} AS finding, f.consumer_operator_id AS operator
          FROM feedback_reports f JOIN contribution_versions v
            ON v.contribution_id = f.contribution_id AND v.version = f.version
          WHERE f.dimension IN ('accuracy','outcome')
            AND f.consumer_operator_id <> v.author_operator_id
            AND ${notSent("report", REPORT_REF)}
          ORDER BY f.contribution_id, f.version LIMIT ${LIMIT}`,
    line: (r) =>
      `${r.title} v${r.version}: ${r.dimension} ${r.finding}, from operator ${r.operator}`,
  },
  {
    kind: "payout_requested",
    title: "Payouts waiting for the operator's wallet approval",
    actionable: false,
    sql: `SELECT CAST(r.request_id AS TEXT) AS ref, r.request_id AS id, r.amount_minor AS amount,
            r.operator_id AS operator
          FROM payout_requests r
          WHERE ${AWAITING_APPROVAL}
            AND ${notSent("payout_requested", "CAST(r.request_id AS TEXT)")}
          ORDER BY r.request_id LIMIT ${LIMIT}`,
    line: (r) => `#${r.id}: ${usdc(r.amount)} for operator ${r.operator}`,
  },
  {
    kind: "deposit",
    title: "Deposits credited",
    actionable: false,
    sql: `SELECT CAST(d.ledger_entry_id AS TEXT) AS ref, d.amount_minor AS amount,
            l.operator_id AS operator
          FROM chain_deposits d JOIN ledger_entries l ON l.entry_id = d.ledger_entry_id
          WHERE ${notSent("deposit", "CAST(d.ledger_entry_id AS TEXT)")}
          ORDER BY d.ledger_entry_id LIMIT ${LIMIT}`,
    line: (r) => `${usdc(r.amount)} from operator ${r.operator}`,
  },
  {
    kind: "operator_enrolled",
    title: "New operators",
    actionable: false,
    sql: `SELECT w.address AS ref, w.operator_id AS operator, w.address AS address
          FROM wallet_accounts w
          WHERE ${notSent("operator_enrolled", "w.address")}
          ORDER BY w.enrolled_at LIMIT ${LIMIT}`,
    line: (r) => `${r.operator} (${r.address})`,
  },
  {
    kind: "need",
    title: "New needs reports",
    actionable: false,
    sql: `SELECT r.id AS ref, r.category AS category, r.summary AS summary
          FROM needs_reports r
          WHERE ${notSent("need", "r.id")}
          ORDER BY r.created_at LIMIT ${LIMIT}`,
    line: (r) => `${r.category}: ${r.summary}`,
  },
];

export type NotifyStatus = "off" | "invalid" | "nothing" | "baseline" | "sent" | "failed";

export interface NotifyResult {
  readonly status: NotifyStatus;
  /** Items announced in this message. */
  readonly items: number;
}

interface Group {
  readonly source: Source;
  readonly rows: readonly Row[];
}

function section(title: string, lines: readonly string[], counted = true): string {
  const shown = lines.slice(0, SECTION_LINES).map((l) => `• ${clip(l, LINE_CHARS)}`);
  if (lines.length > SECTION_LINES) shown.push(`…and ${lines.length - SECTION_LINES} more`);
  return `${counted ? `${title} (${lines.length})` : title}:\n${shown.join("\n")}`;
}

export function formatNew(groups: readonly Group[]): string {
  const parts = groups.map((g) => section(g.source.title, g.rows.map(g.source.line)));
  return clip(["Agent Commons", ...parts].join("\n\n"), MAX_MESSAGE_CHARS);
}

/** Announces new items once; see the module comment. */
export async function notifyNew(
  db: D1Database,
  env: NotifyEnv,
  now: () => Date = () => new Date(),
): Promise<NotifyResult> {
  const config = telegramOf(env);
  if (config.mode !== "on") return { status: config.mode, items: 0 };
  const first =
    (await db.prepare("SELECT 1 AS x FROM notifications_sent WHERE kind = 'baseline'").first()) ===
    null;
  const groups: Group[] = [];
  for (const source of SOURCES) {
    const { results } = await db.prepare(source.sql).all<Row>();
    if (results.length > 0) groups.push({ source, rows: results });
  }
  const announce = groups.filter((g) => g.source.actionable || !first);
  if (announce.length > 0 && !(await config.send(formatNew(announce)))) {
    return { status: "failed", items: 0 };
  }
  const at = now().toISOString();
  const record = groups.flatMap((g) => g.rows.map((r) => [g.source.kind, String(r.ref)]));
  if (first) record.push(["baseline", "v1"]);
  if (record.length > 0) {
    await db.batch(
      record.map(([kind, ref]) =>
        db
          .prepare("INSERT OR IGNORE INTO notifications_sent (kind, ref, sent_at) VALUES (?, ?, ?)")
          .bind(kind, ref, at),
      ),
    );
  }
  const items = announce.reduce((n, g) => n + g.rows.length, 0);
  return { status: items > 0 ? "sent" : first ? "baseline" : "nothing", items };
}

async function count(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const statement = db.prepare(sql).bind(...params);
  return Number((await statement.first<{ n: number }>())?.n ?? 0);
}

/** The daily summary; sent once per daily run. */
export async function dailyDigest(
  db: D1Database,
  now: () => Date,
  report?: ReconciliationReport,
): Promise<string> {
  const day = new Date(now().getTime() - 86_400_000).toISOString().slice(0, 10);
  const since = `${day}T00:00:00.000Z`;

  const usage = new Map(
    (
      await db
        .prepare(
          `SELECT operation, SUM(count) AS n FROM usage_daily_counts WHERE day >= ?
           GROUP BY operation`,
        )
        .bind(day)
        .all<{ operation: string; n: number }>()
    ).results.map((r): [string, number] => [r.operation, Number(r.n)]),
  );
  const ledger = new Map(
    (
      await db
        .prepare(
          `SELECT entry_type, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
           FROM ledger_entries WHERE created_at >= ? GROUP BY entry_type`,
        )
        .bind(since)
        .all<{ entry_type: string; n: number; total: number }>()
    ).results.map((r): [string, { n: number; total: number }] => [
      r.entry_type,
      { n: Number(r.n), total: Number(r.total) },
    ]),
  );
  const of = (type: string) => ledger.get(type) ?? { n: 0, total: 0 };

  const newOperators = await count(
    db,
    "SELECT COUNT(*) AS n FROM wallet_accounts WHERE enrolled_at >= ?",
    since,
  );
  const newVersions = await count(
    db,
    "SELECT COUNT(*) AS n FROM contribution_versions WHERE created_at >= ?",
    since,
  );
  const reviews = await count(
    db,
    "SELECT COUNT(*) AS n FROM version_quality_states WHERE state = 'pending'",
  );
  const validations = await count(
    db,
    `SELECT COUNT(*) AS n FROM ${VERSIONS_WITH_STATE} WHERE ${VALIDATION_DUE}`,
  );
  const toSend = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(r.amount_minor), 0) AS total
       FROM payout_requests r WHERE ${APPROVED_UNSENT}`,
    )
    .first<{ n: number; total: number }>();
  const awaiting = await count(
    db,
    `SELECT COUNT(*) AS n FROM payout_requests r WHERE ${AWAITING_APPROVAL}`,
  );

  const activity = [
    `Searches ${usage.get("search") ?? 0}, retrievals ${usage.get("retrieval") ?? 0}`,
    `Purchases ${of("purchase").n} (${usdc(of("purchase").total)})`,
    `Contributor earnings ${usdc(of("contribution_revenue_share").total)}, verification rewards ${usdc(of("task_earning").total)}`,
    `Deposits ${usdc(of("operator_funding").total)}, payouts sent ${usdc(of("withdrawal").total)}`,
    `Refunds ${of("refund").n}, reversals ${of("reversal").n}`,
    `New operators ${newOperators}, new contribution versions ${newVersions}`,
  ];
  const waiting = [
    `Reviews ${reviews}, validations ${validations}`,
    `Payouts to send ${Number(toSend?.n ?? 0)} (${usdc(toSend?.total ?? 0)})`,
    `Payouts awaiting operator approval ${awaiting}`,
  ];
  const parts = [
    "Agent Commons: daily summary",
    section(`Activity since ${day} (UTC)`, activity, false),
    section("Waiting for you", waiting, false),
  ];
  if (report) {
    parts.push(
      report.ok
        ? "Reconciliation: ok"
        : section(
            "Reconciliation alerts",
            report.alerts.map((a) => `${a.severity} ${a.code}: ${a.message}`),
          ),
    );
  }
  return clip(parts.join("\n\n"), MAX_MESSAGE_CHARS);
}

/** Sends the daily summary; never throws. */
export async function sendDigest(
  db: D1Database,
  env: NotifyEnv,
  now: () => Date = () => new Date(),
  report?: ReconciliationReport,
): Promise<NotifyResult> {
  const config = telegramOf(env);
  if (config.mode !== "on") return { status: config.mode, items: 0 };
  try {
    const ok = await config.send(await dailyDigest(db, now, report));
    return { status: ok ? "sent" : "failed", items: 0 };
  } catch {
    return { status: "failed", items: 0 };
  }
}
