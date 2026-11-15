import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

// Vite 5 cannot resolve the `node:sqlite` builtin via import, so load it with require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const TS = "2026-11-11T00:00:00Z";

function freshDb(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
  return db;
}

let db: DatabaseSyncType;
let n = 0;
const hash = () => (++n).toString(16).padStart(64, "0");

const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
const count = (sql: string, ...p: SQLInputValue[]) => Number(db.prepare(sql).get(...p)?.["c"]);

function addOperator(id: string) {
  run(
    "INSERT INTO operators (id, kind, display_name, created_at) VALUES (?, 'organization', 'Op', ?)",
    id,
    TS,
  );
}
function addAgent(id: string, op: string) {
  run(
    "INSERT INTO agents (id, operator_id, display_name, created_at) VALUES (?, ?, 'Ag', ?)",
    id,
    op,
    TS,
  );
}
function addContribution(id: string, family: string, agent: string, op: string) {
  run(
    "INSERT INTO contributions (id, family, contributor_agent_id, contributor_operator_id, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    family,
    agent,
    op,
    TS,
  );
}
function addVersion(
  id: string,
  version: number,
  family: string,
  agent: string,
  op: string,
  contentHash = hash(),
) {
  run(
    `INSERT INTO contribution_versions (contribution_id, version, previous_version, family, author_agent_id,
       author_operator_id, content_hash, payload_bytes, title, purpose, content_type, license, data_permission,
       review_interval_days, as_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 100, 't', 'p', 'api-limits', 'MIT', 'public', 30, ?, ?)`,
    id,
    version,
    version === 1 ? null : version - 1,
    family,
    agent,
    op,
    contentHash,
    TS,
    TS,
  );
}
function addReference(from: [string, number, string], to: [string, number, string], ordinal = 0) {
  run(
    `INSERT INTO contribution_references (from_contribution_id, from_version, from_family, ordinal,
       to_contribution_id, to_version, to_family) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    from[0],
    from[1],
    from[2],
    ordinal,
    to[0],
    to[1],
    to[2],
  );
}

// Seed: operator op-aaaaaaaa / agent ag-aaaaaaaa; knowledge k-0000001 v1; execution e-0000001 v1.
const OP = "op-aaaaaaaa";
const AG = "ag-aaaaaaaa";
const K = "know-0001";
const E = "exec-0001";

beforeEach(() => {
  db = freshDb();
  addOperator(OP);
  addAgent(AG, OP);
  addContribution(K, "knowledge", AG, OP);
  addVersion(K, 1, "knowledge", AG, OP);
  addContribution(E, "execution", AG, OP);
  addVersion(E, 1, "execution", AG, OP);
});

describe("clean migration", () => {
  it("creates every designed table and index on an empty database", () => {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'contribution\\_search%' ESCAPE '\\'",
      )
      .all()
      .map((r) => r["name"]);
    expect(names.sort()).toEqual(
      [
        "agent_credentials",
        "agents",
        "contribution_evidence",
        "contribution_references",
        "contribution_versions",
        "contributions",
        "execution_target_domains",
        "execution_versions",
        "feedback_reports",
        "knowledge_facts",
        "knowledge_sources",
        "knowledge_versions",
        "needs_reports",
        "operators",
        "rate_limit_windows",
        "retrieval_receipts",
        "version_platform_state",
        "version_quality_states",
      ].sort(),
    );
    // FTS5 virtual table plus its document table (shadow tables are filtered out above).
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE name IN ('contribution_search','contribution_search_documents')",
      ),
    ).toBe(2);
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_idx' ESCAPE '\\'",
      ),
    ).toBe(18);
    expect(
      db
        .prepare("PRAGMA table_info(retrieval_receipts)")
        .all()
        .map((row) => row["name"]),
    ).toEqual(["agent_id", "contribution_id", "version"]);
    expect(
      db
        .prepare("PRAGMA table_info(feedback_reports)")
        .all()
        .map((row) => row["name"]),
    ).toEqual([
      "consumer_operator_id",
      "agent_id",
      "contribution_id",
      "version",
      "dimension",
      "assessment_json",
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("identity", () => {
  it("enforces exactly one existing operator per agent", () => {
    expect(() => addAgent("ag-orphan01", "op-missing1")).toThrow(/FOREIGN KEY/);
    expect(() =>
      run("INSERT INTO agents (id, display_name, created_at) VALUES ('ag-noop0001', 'x', ?)", TS),
    ).toThrow(/NOT NULL/);
  });

  it("forbids rebinding an agent to another operator", () => {
    addOperator("op-bbbbbbbb");
    expect(() => run("UPDATE agents SET operator_id = 'op-bbbbbbbb' WHERE id = ?", AG)).toThrow(
      /immutable/,
    );
    expect(() => run("DELETE FROM agents WHERE id = ?", AG)).toThrow(/cannot be deleted/);
    expect(() => run("DELETE FROM operators WHERE id = ?", OP)).toThrow();
  });

  it("allows status changes on mutable identity fields", () => {
    run("UPDATE agents SET status = 'revoked' WHERE id = ?", AG);
    run("UPDATE operators SET status = 'suspended' WHERE id = ?", OP);
    expect(count("SELECT count(*) AS c FROM agents WHERE status = 'revoked'")).toBe(1);
  });

  it("rejects a contribution whose operator differs from its agent's operator", () => {
    addOperator("op-bbbbbbbb");
    expect(() => addContribution("know-0002", "knowledge", AG, "op-bbbbbbbb")).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects a version authored by another operator's agent", () => {
    addOperator("op-bbbbbbbb");
    addAgent("ag-bbbbbbbb", "op-bbbbbbbb");
    expect(() => addVersion(K, 2, "knowledge", "ag-bbbbbbbb", "op-bbbbbbbb")).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects malformed contribution IDs", () => {
    for (const bad of ["short", "UPPERCASE-ID", "has_underscore", "-leadingdash"]) {
      expect(() => addContribution(bad, "knowledge", AG, OP), bad).toThrow(/CHECK/);
    }
  });
});

describe("versions", () => {
  it("allows a contiguous version chain and rejects gaps and bad predecessors", () => {
    addVersion(K, 2, "knowledge", AG, OP);
    expect(() => addVersion(K, 4, "knowledge", AG, OP)).toThrow(/FOREIGN KEY|CHECK/);
    expect(() =>
      run("UPDATE contribution_versions SET title = 'x' WHERE contribution_id = ?", K),
    ).toThrow(/immutable/);
    expect(() =>
      run(
        `INSERT INTO contribution_versions (contribution_id, version, previous_version, family, author_agent_id,
          author_operator_id, content_hash, payload_bytes, title, purpose, content_type, license, data_permission,
          review_interval_days, as_of, created_at)
         VALUES (?, 3, 1, 'knowledge', ?, ?, ?, 1, 't', 'p', 'c', 'l', 'd', 1, ?, ?)`,
        K,
        AG,
        OP,
        hash(),
        TS,
        TS,
      ),
    ).toThrow(/CHECK/);
  });

  it("rejects a duplicate version number", () => {
    expect(() => addVersion(K, 1, "knowledge", AG, OP)).toThrow(/UNIQUE|PRIMARY/);
  });

  it("rejects a version whose family differs from its contribution", () => {
    expect(() => addVersion(K, 2, "execution", AG, OP)).toThrow(/FOREIGN KEY/);
  });

  it("prevents duplicate content via the unique content hash, across contributions", () => {
    const h = hash();
    addContribution("know-0002", "knowledge", AG, OP);
    addVersion("know-0002", 1, "knowledge", AG, OP, h);
    addContribution("know-0003", "knowledge", AG, OP);
    expect(() => addVersion("know-0003", 1, "knowledge", AG, OP, h)).toThrow(/UNIQUE/);
    expect(() => addVersion("know-0002", 2, "knowledge", AG, OP, h)).toThrow(/UNIQUE/);
  });

  it("rejects malformed content hashes", () => {
    addContribution("know-0002", "knowledge", AG, OP);
    for (const bad of ["abc", "G".repeat(64), "A".repeat(64)]) {
      expect(() => addVersion("know-0002", 1, "knowledge", AG, OP, bad), bad).toThrow(/CHECK/);
    }
  });

  it("makes versions and all child rows immutable and undeletable", () => {
    run(
      "INSERT INTO contribution_evidence (contribution_id, version, ordinal, kind, uri) VALUES (?, 1, 0, 'doc', 'https://example.com')",
      K,
    );
    for (const sql of [
      `UPDATE contributions SET family = 'knowledge'`,
      `DELETE FROM contributions`,
      `DELETE FROM contribution_versions`,
      `UPDATE contribution_evidence SET kind = 'x'`,
      `DELETE FROM contribution_evidence`,
    ]) {
      expect(() => run(sql), sql).toThrow(/immutable/);
    }
    expect(count("SELECT count(*) AS c FROM contribution_versions")).toBe(2);
  });

  it("keeps platform-computed state mutable but non-deletable", () => {
    run(
      "INSERT INTO version_platform_state (contribution_id, version, updated_at) VALUES (?, 1, ?)",
      K,
      TS,
    );
    run(
      "UPDATE version_platform_state SET reliability_score = 0.5, consumer_count = 3, updated_at = ?",
      TS,
    );
    expect(() => run("UPDATE version_platform_state SET version = 2")).toThrow(/immutable/);
    expect(() => run("DELETE FROM version_platform_state")).toThrow(/cannot be deleted/);
    expect(() => run("UPDATE version_platform_state SET reliability_score = 1.5")).toThrow(/CHECK/);
    expect(() => run("UPDATE version_platform_state SET consumer_count = -1")).toThrow(/CHECK/);
  });

  it("requires platform state to point at an existing version", () => {
    expect(() =>
      run(
        "INSERT INTO version_platform_state (contribution_id, version, updated_at) VALUES (?, 9, ?)",
        K,
        TS,
      ),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("family-specific data", () => {
  const knowledgeRow = (id: string, v: number) =>
    run(
      `INSERT INTO knowledge_versions (contribution_id, version, source_license, permitted_use, verification_method)
       VALUES (?, ?, 'CC-BY', 'summary', 'owner-tested')`,
      id,
      v,
    );
  const executionRow = (
    id: string,
    v: number,
    verification = "owner-tested",
    tested: string | null = TS,
  ) =>
    run(
      `INSERT INTO execution_versions (contribution_id, version, objective, inputs_json, outputs_json, steps_json,
         success_checks_json, compatibility_json, side_effect, requires_human_approval, max_requests, timeout_seconds,
         on_failure, verification_method, tested_at)
       VALUES (?, ?, 'o', '[]', '[]', '[]', '[]', '[]', 'read-only', 0, 1, 10, 'stop', ?, ?)`,
      id,
      v,
      verification,
      tested,
    );

  it("stores Knowledge and Execution extensions only under their own family", () => {
    knowledgeRow(K, 1);
    executionRow(E, 1);
    expect(() => knowledgeRow(E, 1)).toThrow(/FOREIGN KEY/);
    expect(() => executionRow(K, 1)).toThrow(/FOREIGN KEY/);
  });

  it("enforces Knowledge limits, JSON validity and source hash format", () => {
    knowledgeRow(K, 1);
    run(
      "INSERT INTO knowledge_facts (contribution_id, version, ordinal, subject, predicate, value_json) VALUES (?, 1, 0, 's', 'p', '429')",
      K,
    );
    expect(() =>
      run(
        "INSERT INTO knowledge_facts (contribution_id, version, ordinal, subject, predicate, value_json) VALUES (?, 1, 1, 's', 'p', '{bad')",
        K,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        `INSERT INTO knowledge_sources (contribution_id, version, ordinal, uri, accessed_at, hash_algorithm, hash_digest)
         VALUES (?, 1, 0, 'https://example.com', ?, 'sha256', 'nothex')`,
        K,
        TS,
      ),
    ).toThrow(/CHECK/);
    run(
      `INSERT INTO knowledge_sources (contribution_id, version, ordinal, uri, accessed_at, hash_algorithm, hash_digest)
       VALUES (?, 1, 0, 'https://example.com', ?, 'sha256', ?)`,
      K,
      TS,
      hash(),
    );
    expect(() => run("DELETE FROM knowledge_sources")).toThrow(/immutable/);
  });

  it("rejects an oversized Knowledge explanation on insert", () => {
    expect(() =>
      run(
        `INSERT INTO knowledge_versions (contribution_id, version, explanation, source_license, permitted_use, verification_method)
         VALUES (?, 1, ?, 'CC-BY', 'summary', 'owner-tested')`,
        K,
        "x".repeat(1001),
      ),
    ).toThrow(/CHECK/);
  });

  it("enforces Execution enumerations, tested_at rule and target domains", () => {
    expect(() => executionRow(E, 1, "owner-tested", null)).toThrow(/CHECK/);
    expect(() => executionRow(E, 1, "bogus")).toThrow(/CHECK/);
    executionRow(E, 1);
    run(
      "INSERT INTO execution_target_domains (contribution_id, version, domain) VALUES (?, 1, 'api.acme.com')",
      E,
    );
    expect(() =>
      run(
        "INSERT INTO execution_target_domains (contribution_id, version, domain) VALUES (?, 1, 'api.acme.com')",
        E,
      ),
    ).toThrow(/UNIQUE|PRIMARY/);
    expect(() => run("DELETE FROM execution_target_domains")).toThrow(/immutable/);
  });
});

describe("cross-family references", () => {
  it("accepts a reference to an existing exact opposite-family version", () => {
    addReference([E, 1, "execution"], [K, 1, "knowledge"]);
    expect(count("SELECT count(*) AS c FROM contribution_references")).toBe(1);
  });

  it("rejects references to nonexistent versions, wrong families and same-family targets", () => {
    expect(() => addReference([E, 1, "execution"], [K, 2, "knowledge"])).toThrow(/FOREIGN KEY/);
    expect(() => addReference([E, 1, "execution"], ["know-9999", 1, "knowledge"])).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => addReference([E, 1, "execution"], [K, 1, "execution"])).toThrow(
      /FOREIGN KEY|CHECK/,
    );
    expect(() => addReference([E, 1, "execution"], [E, 1, "execution"])).toThrow(/CHECK/);
    expect(() => addReference([E, 1, "knowledge"], [K, 1, "knowledge"])).toThrow(
      /CHECK|FOREIGN KEY/,
    );
  });

  it("rejects duplicate references but allows different exact versions of one target", () => {
    addVersion(K, 2, "knowledge", AG, OP);
    addReference([E, 1, "execution"], [K, 1, "knowledge"], 0);
    expect(() => addReference([E, 1, "execution"], [K, 1, "knowledge"], 1)).toThrow(/UNIQUE/);
    addReference([E, 1, "execution"], [K, 2, "knowledge"], 1);
    expect(count("SELECT count(*) AS c FROM contribution_references")).toBe(2);
  });

  it("blocks deleting or altering a referenced version", () => {
    addReference([E, 1, "execution"], [K, 1, "knowledge"]);
    expect(() => run("DELETE FROM contribution_versions WHERE contribution_id = ?", K)).toThrow();
    expect(() => run("DELETE FROM contribution_references")).toThrow(/immutable/);
  });
});

describe("integrity queries from docs/d1-schema.md", () => {
  it("detect versions missing extension rows and platform state", () => {
    const missingExt = db
      .prepare(
        `SELECT v.contribution_id FROM contribution_versions v
         WHERE (v.family = 'knowledge' AND NOT EXISTS (SELECT 1 FROM knowledge_versions k
                  WHERE k.contribution_id = v.contribution_id AND k.version = v.version))
            OR (v.family = 'execution' AND NOT EXISTS (SELECT 1 FROM execution_versions e
                  WHERE e.contribution_id = v.contribution_id AND e.version = v.version))`,
      )
      .all();
    expect(missingExt).toHaveLength(2);
  });
});

describe("needs_reports", () => {
  const FP = "f".repeat(64);
  const insert = (id: string, op: string, agent: string, category = "missing_capability") =>
    run(
      `INSERT INTO needs_reports (id, operator_id, agent_id, fingerprint, category, summary,
         desired_outcome, search_terms_json, created_at, last_reported_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'need', 'outcome', '[]', ?, ?, ?)`,
      id,
      op,
      agent,
      FP,
      category,
      TS,
      TS,
      TS,
    );

  it("keeps one row per operator and fingerprint, bound to that operator's agent", () => {
    insert("n1", OP, AG);
    expect(() => insert("n2", OP, AG)).toThrow(/UNIQUE/);
    addOperator("op-bbbbbbbb");
    addAgent("ag-bbbbbbbb", "op-bbbbbbbb");
    insert("n3", "op-bbbbbbbb", "ag-bbbbbbbb");
    expect(() => insert("n4", "op-cccccccc", AG)).toThrow(/FOREIGN KEY/);
    expect(() => insert("n5", OP, AG, "bug")).toThrow(/CHECK/);
    expect(count("SELECT count(*) AS c FROM needs_reports")).toBe(2);
  });
});

describe("version_quality_states", () => {
  const states = () =>
    db
      .prepare(
        "SELECT contribution_id AS id, version, state FROM version_quality_states WHERE contribution_id = ? ORDER BY version",
      )
      .all(K);

  it("gives every newly inserted version an initial pending state", () => {
    addVersion(K, 2, "knowledge", AG, OP);
    expect(states()).toEqual([
      { id: K, version: 1, state: "pending" },
      { id: K, version: 2, state: "pending" },
    ]);
    expect(count("SELECT count(*) AS c FROM version_quality_states WHERE state <> 'pending'")).toBe(
      0,
    );
  });

  it("backfills pre-existing versions as pending, never approved", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("PRAGMA foreign_keys = ON");
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < "0008")
      .sort();
    for (const f of files) old.exec(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
    const prior = db;
    db = old;
    addOperator(OP);
    addAgent(AG, OP);
    addContribution(K, "knowledge", AG, OP);
    addVersion(K, 1, "knowledge", AG, OP);
    addVersion(K, 2, "knowledge", AG, OP);
    old.exec(readFileSync(new URL("0008_version_quality_states.sql", MIGRATIONS_DIR), "utf8"));
    expect(states()).toEqual([
      { id: K, version: 1, state: "pending" },
      { id: K, version: 2, state: "pending" },
    ]);
    db = prior;
  });

  it("accepts only the four designed states", () => {
    for (const s of ["listed_unverified", "rejected", "withdrawn", "pending"])
      run(
        "UPDATE version_quality_states SET state = ?, updated_at = ? WHERE contribution_id = ?",
        s,
        TS,
        K,
      );
    for (const s of ["approved", "verified", "", "PENDING"])
      expect(() => run("UPDATE version_quality_states SET state = ?", s)).toThrow(/CHECK/);
  });

  it("requires an existing version, an immutable key and no deletion", () => {
    expect(() =>
      run(
        "INSERT INTO version_quality_states (contribution_id, version, state, updated_at) VALUES (?, 9, 'pending', ?)",
        K,
        TS,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => run("UPDATE version_quality_states SET version = 2")).toThrow(/immutable/);
    expect(() => run("DELETE FROM version_quality_states")).toThrow(/cannot be deleted/);
    expect(() =>
      run(
        "INSERT INTO version_quality_states (contribution_id, version, state, updated_at) VALUES (?, 1, 'pending', ?)",
        K,
        TS,
      ),
    ).toThrow(/UNIQUE|PRIMARY/);
  });
});
