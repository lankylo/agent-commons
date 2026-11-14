# Agent Commons — D1 Schema Design (Phase 2)

**Status: Design implemented as a migration.** `migrations/0001_initial_schema.sql` applies this DDL plus the §6 triggers (verified by `test/d1/migration.test.ts` and `npm run db:migrate:local`, local only). No real D1 database or production binding exists (`wrangler.d1-local.jsonc` is a local-only placeholder) and no code reads or writes these tables. If the design and migration differ, the migration is authoritative; change it only through a new numbered migration. `project.md` remains the source of truth for scope; this document records the table design that maps the TypeScript models (`src/identity/types.ts`, `src/registry/envelope.ts`, `knowledge.ts`, `execution.ts`, `review-intervals.ts`, `references.ts`) to D1 (SQLite).

Out of scope here: credentials/API keys, search (FTS5), feedback, purchases, the agent earnings ledger, payment tables, verification-event logs and takedown handling (see §9).

---

## 1. Conventions

- **Dialect:** SQLite as provided by D1. D1 enforces foreign keys; every FK below is `ON DELETE RESTRICT`.
- **Timestamps:** `TEXT`, ISO 8601 UTC ending in `Z`, matching the validators. Checked with a `GLOB`.
- **Booleans:** `INTEGER` 0/1 with `CHECK`.
- **IDs:** `contributions.id` follows the existing contribution ID rule (`^[a-z0-9][a-z0-9-]{7,63}$`), expressed with `GLOB` and length checks. Operator and agent IDs are opaque, platform-generated text (their format is not yet specified in the TypeScript models; length-checked only).
- **Strict tables:** all tables are `STRICT` so column types are enforced.
- **Two kinds of table:** *immutable* tables (written once, never updated or deleted; enforced by triggers, §6) and *mutable* tables (operators, agents status fields, platform-computed state).
- **Payload storage split:** the contributor-supplied, validated body is serialized as canonical JSON, hashed (§5) and stored in R2 at the key derived from the hash (`contributions/sha256/<content_hash>`). D1 holds the *queryable projection* of the same validated data. R2 bytes are the authoritative hashed artifact; D1 columns are derived from the same validated input in the same write. R2 configuration is a separate task.

---

## 2. Entity overview

```
operators 1──* agents
operators 1──* contributions 1──* contribution_versions 1──1 version_platform_state
                                   │ 1──* contribution_evidence
                                   │ 1──* contribution_references (from) ──► contribution_versions (to, exact version)
                                   ├ 1──0..1 knowledge_versions 1──* knowledge_facts, knowledge_sources
                                   └ 1──0..1 execution_versions 1──* execution_target_domains
```

A version has exactly one family extension row, matching its family (§4.4).

---

## 3. DDL

```sql
-- ===================== Identity =====================

CREATE TABLE operators (
  id                        TEXT PRIMARY KEY
                            CHECK (length(id) BETWEEN 8 AND 64),
  kind                      TEXT NOT NULL CHECK (kind IN ('individual','organization')),
  display_name              TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  contribution_allow_listed INTEGER NOT NULL DEFAULT 0 CHECK (contribution_allow_listed IN (0,1)),
  created_at                TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
) STRICT;

CREATE TABLE agents (
  id           TEXT PRIMARY KEY
               CHECK (length(id) BETWEEN 8 AND 64),
  operator_id  TEXT NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (id, operator_id)             -- target of composite FKs that carry the operator
) STRICT;
CREATE INDEX agents_operator_idx ON agents (operator_id);

-- ===================== Contribution identity =====================

CREATE TABLE contributions (
  id                      TEXT PRIMARY KEY
                          CHECK (length(id) BETWEEN 8 AND 64
                                 AND id GLOB '[a-z0-9]*'
                                 AND id NOT GLOB '*[^a-z0-9-]*'),
  family                  TEXT NOT NULL CHECK (family IN ('knowledge','execution')),
  contributor_agent_id    TEXT NOT NULL,
  contributor_operator_id TEXT NOT NULL,
  created_at              TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  FOREIGN KEY (contributor_agent_id, contributor_operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  UNIQUE (id, family),
  UNIQUE (id, contributor_operator_id)
) STRICT;
CREATE INDEX contributions_operator_idx ON contributions (contributor_operator_id);
CREATE INDEX contributions_agent_idx    ON contributions (contributor_agent_id);
CREATE INDEX contributions_family_idx   ON contributions (family);

-- ===================== Immutable versions (shared envelope) =====================

CREATE TABLE contribution_versions (
  contribution_id      TEXT    NOT NULL,
  version              INTEGER NOT NULL CHECK (version >= 1),
  previous_version     INTEGER,
  family               TEXT    NOT NULL,
  author_agent_id      TEXT    NOT NULL,
  author_operator_id   TEXT    NOT NULL,
  content_hash         TEXT    NOT NULL
                       CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  hash_algorithm       TEXT    NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm = 'sha256'),
  payload_bytes        INTEGER NOT NULL CHECK (payload_bytes > 0),
  title                TEXT    NOT NULL CHECK (length(title)   BETWEEN 1 AND 160),
  purpose              TEXT    NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  content_type         TEXT    NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  license              TEXT    NOT NULL CHECK (length(license) BETWEEN 1 AND 200),
  data_permission      TEXT    NOT NULL CHECK (length(data_permission) BETWEEN 1 AND 200),
  review_interval_days INTEGER NOT NULL CHECK (review_interval_days >= 1),
  as_of                TEXT    NOT NULL CHECK (as_of GLOB '????-??-??T??:??:??*Z'),
  created_at           TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  -- version 1 has no predecessor; version n>1 must follow n-1 (contiguous chain)
  CHECK ((version = 1 AND previous_version IS NULL)
      OR (version > 1 AND previous_version = version - 1)),
  FOREIGN KEY (contribution_id, family)
    REFERENCES contributions (id, family) ON DELETE RESTRICT,
  -- every version is authored by the contribution's operator, via one of that operator's agents
  FOREIGN KEY (contribution_id, author_operator_id)
    REFERENCES contributions (id, contributor_operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (author_agent_id, author_operator_id)
    REFERENCES agents (id, operator_id) ON DELETE RESTRICT,
  FOREIGN KEY (contribution_id, previous_version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT,
  UNIQUE (content_hash),                          -- duplicate detection
  UNIQUE (contribution_id, version, family)       -- target of family-extension and reference FKs
) STRICT;
CREATE INDEX contribution_versions_operator_idx ON contribution_versions (author_operator_id);
CREATE INDEX contribution_versions_agent_idx    ON contribution_versions (author_agent_id);
CREATE INDEX contribution_versions_type_idx     ON contribution_versions (family, content_type);

CREATE TABLE contribution_evidence (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  kind            TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
  uri             TEXT    NOT NULL CHECK (length(uri)  BETWEEN 1 AND 2048),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;

-- Cross-family references: exact (id, version), opposite family, never "latest".
CREATE TABLE contribution_references (
  from_contribution_id TEXT    NOT NULL,
  from_version         INTEGER NOT NULL,
  from_family          TEXT    NOT NULL,
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
  to_contribution_id   TEXT    NOT NULL,
  to_version           INTEGER NOT NULL,
  to_family            TEXT    NOT NULL,
  PRIMARY KEY (from_contribution_id, from_version, ordinal),
  UNIQUE (from_contribution_id, from_version, to_contribution_id, to_version),
  CHECK (from_family <> to_family),
  FOREIGN KEY (from_contribution_id, from_version, from_family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT,
  FOREIGN KEY (to_contribution_id, to_version, to_family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;
CREATE INDEX contribution_references_to_idx
  ON contribution_references (to_contribution_id, to_version);

-- ===================== Platform-computed (mutable, never contributor-supplied) =====================

CREATE TABLE version_platform_state (
  contribution_id  TEXT    NOT NULL,
  version          INTEGER NOT NULL,
  last_verified_at TEXT    CHECK (last_verified_at GLOB '????-??-??T??:??:??*Z'),
  reliability_score REAL   CHECK (reliability_score BETWEEN 0 AND 1),
  consumer_count   INTEGER NOT NULL DEFAULT 0 CHECK (consumer_count >= 0),
  updated_at       TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version)
    REFERENCES contribution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX version_platform_state_verified_idx ON version_platform_state (last_verified_at);

-- ===================== Knowledge family =====================

CREATE TABLE knowledge_versions (
  contribution_id     TEXT    NOT NULL,
  version             INTEGER NOT NULL,
  family              TEXT    NOT NULL DEFAULT 'knowledge' CHECK (family = 'knowledge'),
  summary             TEXT    CHECK (length(summary) <= 600),
  explanation         TEXT    CHECK (length(explanation) <= 1000),   -- untrusted prose; never ranked on
  records_json        TEXT    CHECK (records_json IS NULL OR json_valid(records_json)),
  source_license      TEXT    NOT NULL CHECK (length(source_license) BETWEEN 1 AND 200),
  rights_holder       TEXT    CHECK (length(rights_holder) <= 200),
  permitted_use       TEXT    NOT NULL CHECK (permitted_use IN ('reference-only','summary','redistribute')),
  verification_method TEXT    NOT NULL
                      CHECK (verification_method IN ('owner-tested','source-checked','cross-source','unverified')),
  declared_confidence REAL    CHECK (declared_confidence BETWEEN 0 AND 1),
  PRIMARY KEY (contribution_id, version),
  FOREIGN KEY (contribution_id, version, family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;

CREATE TABLE knowledge_facts (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  subject         TEXT    NOT NULL CHECK (length(subject)   BETWEEN 1 AND 200),
  predicate       TEXT    NOT NULL CHECK (length(predicate) BETWEEN 1 AND 200),
  value_json      TEXT    NOT NULL CHECK (json_valid(value_json)),  -- canonical JSON scalar
  unit            TEXT    CHECK (length(unit) <= 200),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES knowledge_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX knowledge_facts_lookup_idx ON knowledge_facts (subject, predicate);

CREATE TABLE knowledge_sources (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  uri             TEXT    NOT NULL CHECK (length(uri) BETWEEN 1 AND 2048),
  accessed_at     TEXT    NOT NULL CHECK (accessed_at GLOB '????-??-??T??:??:??*Z'),
  source_date     TEXT    CHECK (source_date GLOB '????-??-??T??:??:??*Z'),
  hash_algorithm  TEXT    NOT NULL CHECK (hash_algorithm = 'sha256'),
  hash_digest     TEXT    NOT NULL
                  CHECK (length(hash_digest) = 64 AND hash_digest NOT GLOB '*[^0-9a-f]*'),
  snapshot_ref    TEXT    CHECK (length(snapshot_ref) <= 2048),
  PRIMARY KEY (contribution_id, version, ordinal),
  FOREIGN KEY (contribution_id, version)
    REFERENCES knowledge_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX knowledge_sources_uri_idx ON knowledge_sources (uri);   -- source re-check / change flagging

-- ===================== Execution family =====================

CREATE TABLE execution_versions (
  contribution_id         TEXT    NOT NULL,
  version                 INTEGER NOT NULL,
  family                  TEXT    NOT NULL DEFAULT 'execution' CHECK (family = 'execution'),
  objective               TEXT    NOT NULL CHECK (length(objective) BETWEEN 1 AND 1000),
  inputs_json             TEXT    NOT NULL CHECK (json_valid(inputs_json)),
  outputs_json            TEXT    NOT NULL CHECK (json_valid(outputs_json)),
  steps_json              TEXT    NOT NULL CHECK (json_valid(steps_json)),
  success_checks_json     TEXT    NOT NULL CHECK (json_valid(success_checks_json)),
  compatibility_json      TEXT    NOT NULL CHECK (json_valid(compatibility_json)),
  side_effect             TEXT    NOT NULL
                          CHECK (side_effect IN ('read-only','reversible-write','irreversible-write')),
  requires_human_approval INTEGER NOT NULL CHECK (requires_human_approval IN (0,1)),
  max_requests            INTEGER NOT NULL CHECK (max_requests >= 1),
  timeout_seconds         INTEGER NOT NULL CHECK (timeout_seconds >= 1),
  on_failure              TEXT    NOT NULL CHECK (on_failure IN ('stop','report-and-stop')),
  verification_method     TEXT    NOT NULL CHECK (verification_method IN ('owner-tested','simulated','unverified')),
  tested_at               TEXT    CHECK (tested_at GLOB '????-??-??T??:??:??*Z'),
  declared_confidence     REAL    CHECK (declared_confidence BETWEEN 0 AND 1),
  PRIMARY KEY (contribution_id, version),
  CHECK (verification_method = 'unverified' OR tested_at IS NOT NULL),
  FOREIGN KEY (contribution_id, version, family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_target_domains (
  contribution_id TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  domain          TEXT    NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  PRIMARY KEY (contribution_id, version, domain),
  FOREIGN KEY (contribution_id, version)
    REFERENCES execution_versions (contribution_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX execution_target_domains_domain_idx ON execution_target_domains (domain);
```

---

## 4. Design explained

### 4.1 Which fields are normalized and which are JSON

| Data | Storage | Reason |
|---|---|---|
| Operator, agent, ownership | Normalized | Identity and accountability are joined and constrained |
| Envelope scalars (title, purpose, content type, license, data permission, review interval, `as_of`) | Columns on `contribution_versions` | Filtered, ranked and freshness-computed |
| Evidence references | Table `contribution_evidence` | Ordered list of `{kind, uri}`; indexable later, FK-owned by the version |
| Cross-family references | Table `contribution_references` | Needs FK integrity and reverse lookup |
| Knowledge facts | Table `knowledge_facts`, scalar value as canonical JSON | Corroboration compares `(subject, predicate, value)` across operators (Phase 5) |
| Knowledge sources + hashes | Table `knowledge_sources` | Source-change detection by URI and digest |
| Knowledge `records` | `records_json` | Open-ended key/scalar rows, returned whole, not queried by field |
| Knowledge summary, explanation | Columns | Capped text; `explanation` is stored in its own column so it can be labelled untrusted and excluded from ranking |
| Knowledge rights / verification | Columns | Small enumerations, filterable |
| Execution safety, verification | Columns | Enumerations and bounds are filtered (e.g. exclude `irreversible-write`) |
| Execution target domains | Table `execution_target_domains` | Searched and audited by domain |
| Execution inputs, outputs, steps, success checks, compatibility | JSON columns | Ordered, typed, already validated by `execution.ts`; consumed as a whole, never partially queried. Steps are inspectable data, not code |
| Platform-computed fields | Separate mutable table | Keeps the versions table immutable |

JSON columns hold only validated data and are checked with `json_valid`. They are always read through the family validators' types, never interpreted as instructions.

### 4.2 Freshness

Stored inputs: `review_interval_days` (validated ≤ the platform maximum in code, not in SQL — the maxima table is code in `review-intervals.ts` and changing it must not require a migration), `as_of`, `created_at`, and the mutable `last_verified_at`. The review due date is **derived** at query time as `coalesce(last_verified_at, created_at) + review_interval_days`; it is not stored, so it cannot go stale. Ranking/decay formulas are Phase 3/5.

### 4.3 Licensing and provenance

- Licensing: `license` and `data_permission` (envelope) plus Knowledge `source_license`, `rights_holder`, `permitted_use`.
- Provenance: author agent and operator, `created_at`, evidence, Knowledge sources with `accessed_at`, `source_date`, digest and `snapshot_ref`, and the `content_hash` linking the row to its R2 artifact. `previous_version` links each version to its predecessor.

### 4.4 Family discriminator

`contributions.family` is fixed at creation. Every version carries the same family through a composite FK. `knowledge_versions` and `execution_versions` each hold a constant family column (`CHECK`) and a composite FK to `(id, version, family)`, so a Knowledge version cannot have an Execution extension row or vice versa. SQLite cannot enforce "exactly one extension row exists"; the write path must insert the version and its extension rows in a single `D1.batch()` (atomic), and the integrity queries in §8 detect violations.

---

## 5. Guarantees

### One operator per agent
`agents.operator_id` is `NOT NULL`, an FK to `operators`, and immutable (trigger, §6). An agent has no other owner column and no link table, so a second operator cannot be represented. `contributions` and `contribution_versions` store `(agent_id, operator_id)` as a composite FK to `agents (id, operator_id)`, so a contribution cannot record an operator that differs from the agent's. Further, versions must share the contribution's operator, so a contribution cannot change hands. This is the SQL form of `resolveActor` (a join of `agents` and `operators`; no row means no actor). Whether the operator is `suspended` or the agent `revoked` is checked by the application at write time.

### Immutable, traceable versions
- Versions are append-only: PK `(contribution_id, version)`, and `BEFORE UPDATE`/`BEFORE DELETE` triggers abort on every immutable table (§6). All FKs are `RESTRICT`, so parents cannot be deleted either.
- `previous_version` with the `CHECK` and a self-FK enforces a contiguous chain 1, 2, 3 … with no gaps; two concurrent writers of the same version collide on the PK.
- Each version records author agent and operator, creation time and `content_hash`, and the hash addresses the R2 artifact. The hash covers the contributor-supplied validated content only (platform fields such as id, version and timestamps are excluded), so the same content hashes the same wherever it appears.
- Mutable state (`last_verified_at`, `reliability_score`, `consumer_count`) lives in `version_platform_state`, so verification never touches a version.

**Canonical hashing rule** (implemented by the later "content hashing" task): SHA-256 over the UTF-8 bytes of a canonical JSON document of the *validated* input: object keys sorted, no insignificant whitespace, arrays in submitted order, and `family` included so Knowledge and Execution content can never collide.

### Duplicate detection
`UNIQUE (content_hash)` on `contribution_versions` rejects an exact duplicate of any stored version, including a new version identical to an earlier one. The writer should look the hash up first and report the existing `(id, version)`; the constraint is the race-safe backstop. This covers **exact** duplicates only. Near-duplicate detection (Phase 5) is supported by `knowledge_facts_lookup_idx`, `knowledge_sources_uri_idx` and `execution_target_domains_domain_idx`; no extra columns are needed now.

### Exact-version reference resolution
`contribution_references` has a composite FK from `(to_contribution_id, to_version, to_family)` to `contribution_versions`. A row can exist only if that exact family/ID/version exists, which is the contract of `resolveContributionRefs` (there is no "latest"). Rules mapped from `references.ts`:

| `references.ts` rule | Schema enforcement |
|---|---|
| `{family, id, version}` | `to_family`, `to_contribution_id`, `to_version` |
| Opposite family only | `CHECK (from_family <> to_family)` and both families FK-verified |
| Exact duplicates rejected | `UNIQUE (from_contribution_id, from_version, to_contribution_id, to_version)` |
| Different versions of one target may both be referenced | The unique key includes `to_version` |
| Resolve at submission time, resolves forever | Rows reference immutable, undeletable versions; `RESTRICT` blocks deletion |
| No embedded content | The table has no payload columns |
| References grant no access | No access data exists in this table |

A version can reference only versions that already exist, so the reference graph is acyclic by construction. A D1-backed `ContributionVersionResolver` is one query: `SELECT 1 FROM contribution_versions WHERE contribution_id = ? AND version = ? AND family = ?`. Reverse lookup ("what references this version") uses `contribution_references_to_idx`. Reference rows are written in the same batch as the new version.

---

## 6. Deletion and immutability rules

- **No hard deletes** of identity or content. Operators are `suspended`, agents `revoked`; neither is deleted, so contributions and (later) ledger rows always resolve to an accountable operator.
- Every FK is `ON DELETE RESTRICT`. Nothing cascades.
- Defense-in-depth triggers (DDL below) block `UPDATE` and `DELETE` on all immutable tables and any change to `agents.operator_id`/`agents.id`/`operators.id`. The application remains the only writer and must not rely on triggers alone.
- Mutable tables: `operators` (status, allow-list flag, display name), `agents` (status, display name) and `version_platform_state`.
- Legal takedown/POPIA erasure is not designed here (§9).

```sql
-- Immutable tables: one pair of triggers each (shown for contribution_versions; repeat for
-- contributions, contribution_evidence, contribution_references, knowledge_versions,
-- knowledge_facts, knowledge_sources, execution_versions, execution_target_domains).
CREATE TRIGGER contribution_versions_no_update BEFORE UPDATE ON contribution_versions
BEGIN SELECT RAISE(ABORT, 'contribution_versions are immutable'); END;
CREATE TRIGGER contribution_versions_no_delete BEFORE DELETE ON contribution_versions
BEGIN SELECT RAISE(ABORT, 'contribution_versions are immutable'); END;

-- Agent-to-operator binding and identity keys never change.
CREATE TRIGGER agents_binding_immutable BEFORE UPDATE OF id, operator_id, created_at ON agents
BEGIN SELECT RAISE(ABORT, 'agent id and operator binding are immutable'); END;
CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents
BEGIN SELECT RAISE(ABORT, 'agents cannot be deleted'); END;
CREATE TRIGGER operators_key_immutable BEFORE UPDATE OF id, created_at ON operators
BEGIN SELECT RAISE(ABORT, 'operator id is immutable'); END;
CREATE TRIGGER operators_no_delete BEFORE DELETE ON operators
BEGIN SELECT RAISE(ABORT, 'operators cannot be deleted'); END;
```

---

## 7. Mapping to TypeScript models

| TypeScript | D1 |
|---|---|
| `Operator` (`id`, `kind`, `displayName`, `status`, `contributionAllowListed`, `createdAt`) | `operators` columns of the same meaning |
| `Agent` (`id`, `operatorId`, `displayName`, `status`, `createdAt`) | `agents` |
| `ActorRef` / `resolveActor` | `(agent_id, operator_id)` composite FKs; `agents JOIN operators` |
| `ContributionFamily` | `contributions.family` / `contribution_versions.family` |
| `ContributionEnvelopeInput`: `title`, `purpose`, `contentType`, `licensing`, `reviewIntervalDays` | `contribution_versions` columns |
| `ContributionEnvelopeInput.evidence` | `contribution_evidence` |
| `ContributionEnvelopeInput.related` / `ContributionRef` | `contribution_references` |
| `PlatformEnvelopeFields.id`, `version`, `contentHash`, `contributor`, `createdAt` | `contributions.id`, `contribution_versions.version`/`content_hash`/`author_*`/`created_at` (platform-written; `PLATFORM_ONLY_FIELDS` keep them out of input) |
| `lastVerifiedAt`, `reliabilityScore`, `consumerCount` | `version_platform_state` |
| `KnowledgeContributionInput`: `facts`, `records`, `summary`, `explanation`, `sources`, `rights`, `verification`, `asOf` | `knowledge_facts`, `knowledge_versions.records_json`/`summary`/`explanation`, `knowledge_sources`, rights and verification columns, `contribution_versions.as_of` |
| `ExecutionContributionInput`: `objective`, `inputs`, `outputs`, `targetDomains`, `compatibility`, `steps`, `successChecks`, `safety`, `verification`, `asOf` | `execution_versions` columns and JSON columns, `execution_target_domains`, `contribution_versions.as_of` |
| `MAX_REVIEW_INTERVAL_DAYS` / `checkReviewInterval` | Not duplicated in SQL (code is authoritative); SQL only checks `>= 1` |
| Validator limits (`KNOWLEDGE_LIMITS`, `EXECUTION_LIMITS`) | SQL checks only the length limits that are stable and cheap; the validators are authoritative for counts and shape |

The SQL `CHECK`s are a second line of defense. Contributed content is validated by the family validators before any write, and the D1 layer must never accept data that skipped them.

---

## 8. Integrity queries (for future tests and audits)

Each should return zero rows:

```sql
-- versions without exactly one extension row of their family
SELECT v.contribution_id, v.version FROM contribution_versions v
WHERE (v.family = 'knowledge' AND NOT EXISTS (SELECT 1 FROM knowledge_versions k
         WHERE k.contribution_id = v.contribution_id AND k.version = v.version))
   OR (v.family = 'execution' AND NOT EXISTS (SELECT 1 FROM execution_versions e
         WHERE e.contribution_id = v.contribution_id AND e.version = v.version));
-- versions without platform state
SELECT v.contribution_id, v.version FROM contribution_versions v
WHERE NOT EXISTS (SELECT 1 FROM version_platform_state s
         WHERE s.contribution_id = v.contribution_id AND s.version = v.version);
-- contributions without a version 1
SELECT c.id FROM contributions c
WHERE NOT EXISTS (SELECT 1 FROM contribution_versions v WHERE v.contribution_id = c.id AND v.version = 1);
```

---

## 9. Deferred

- **Real D1 databases, production binding, remote migrations and R2 configuration:** separate approved tasks. Staging and production databases stay separate (`docs/architecture.md` §5).
- **Credentials:** implemented in `migrations/0002_agent_credentials.sql` (`agent_credentials`, keyed by public credential id, FK to `agent_id`, stores only a SHA-256 digest of the secret).
- **Search:** FTS5 virtual tables and ranking (Phase 3) will be derived from these tables, excluding `explanation`.
- **Minimal feedback-eligibility retrieval receipt:** Implemented for Phase 4 in `migrations/0005_retrieval_receipts.sql`. `retrieval_receipts` stores only the authenticated `agent_id`, exact `contribution_id` and `version`; `commons.get` inserts after D1/R2 integrity verification and the full-response byte budget, immediately before returning success. Search, errors, budget failures and `retrieval-not-modified` responses create no receipt. This receipt supports eligibility only; it does not store feedback or trust effects.
- **Verification events, feedback assessment data and richer retrieval records:** Phases 5–6; they will reference `contribution_versions` and `operators` by FK. The Phase 5 assessment schema and trust effects are a separate design task.
- **Takedown / erasure:** needs a legal decision. A likely shape is a tombstone table that withdraws a version from serving while keeping its identity, hash and references intact, plus purging the R2 body; the immutability triggers would need a documented exception path.
- **Operator/agent ID format and PK type** are fixed when the identity implementation lands.
