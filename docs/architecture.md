# Agent Commons — Architecture

`project.md` is the source of truth for scope, roadmap and decisions. This document records the implementation architecture and boundaries. It does not duplicate requirements, and it deliberately defines **no API contracts** (those belong in `docs/api.md`) and keeps table designs in `docs/d1-schema.md` (Phase 2 design only; no migrations or bindings exist).

**Status legend:** **Implemented** = exists in the repository and is verified. **Planned** = intended design only; not implemented, not configured, subject to change in the phase noted.

---

## 1. Current Foundation (Implemented)

| Item | State |
|---|---|
| Runtime | Single Cloudflare Worker, TypeScript (ES modules), entry `src/index.ts` |
| Routes | `GET /health` returns `{ status: "ok", service: "agent-commons" }`; every other path returns 404 |
| Config | `wrangler.jsonc` with only `name`, `main`, `compatibility_date`. No bindings (no D1, R2, Queues, KV, Vectorize), no routes, no secrets, no environments |
| Tests | Vitest (`test/index.test.ts`) calls the Worker `fetch` handler directly |
| Quality gates | `npm run typecheck`, `npm run lint` (ESLint, zero warnings), `npm test` |
| CI | `.github/workflows/validate.yml` runs `npm ci`, typecheck, lint, test and `wrangler deploy --dry-run` on pull requests and pushes to `main`. It has read-only permissions and no Cloudflare credentials |
| Development agent | `.github/workflows/claude-manual.yml`: manual dispatch only; development-only (see `project.md` Section 5) |

Nothing is deployed to production by the repository's automation.

---

## 2. Architectural Principles

Derived from `project.md` Section 3:

- Serverless-first; no always-on servers.
- Production code is LLM-free for deterministic operations. Claude/Anthropic is development-only; no Anthropic key or SDK belongs in the Worker.
- Modular components that are independently testable; external services reached through adapters.
- Contributed content (Knowledge and Execution) is untrusted data, and the two families keep distinct schemas, validation and retrieval paths.
- Financial and credit operations are authorized, idempotent and auditable.
- Every agent identity resolves to exactly one accountable operator.

---

## 3. Component Boundaries

All components below except the Worker shell and `/health` are **Planned**. The boundaries describe responsibility only; interfaces will be specified when each phase starts.

```
 Agents ──REST──┐
                ├─► Worker (routing, auth, rate limits)
 Agents ──MCP───┘        │
                         ▼
        ┌──── domain modules (pure, testable) ────┐
        │ identity │ registry │ validation │ search │ payments │ credits │
        └────┬──────────┬──────────────────┬───────────┬───────┘
             ▼          ▼                  ▼           ▼
            D1         R2          x402 facilitator   (Queues / Vectorize, only if needed)
```

| Component | Responsibility | Phase | Status |
|---|---|---|---|
| Worker shell | Request entry, routing, `/health` | 1 | Implemented |
| REST interface | Thin HTTP adapter over domain modules; machine-readable errors | 4 | Planned |
| MCP interface | Thin MCP adapter over the same domain modules, so REST and MCP behave identically | 4 | Planned |
| Identity | Operators, agents bound to one operator, per-agent credentials, operator spending limits | 2 | Partial: operators, agents and local D1 credentials implemented; spending limits and HTTP authentication planned |
| Registry (D1 metadata) | Contribution envelope, `family` discriminator, immutable versions, hashes, freshness/reliability fields, cross-family references | 2 | Planned |
| Artifact storage (R2) | Full contribution payloads, addressed by content hash/version. D1 holds metadata and the pointer; R2 holds bodies | 2 | Planned |
| Validation | Separate Knowledge and Execution validation, duplicate detection, secret/personal-data scanning, provenance, quality states | 2 (schemas), 5 (trust) | Planned |
| Search | D1 FTS5 keyword + metadata search, deterministic family-aware ranking. Vectorize only if Phase 3 acceptance testing fails | 3 | Planned |
| Payments | x402 adapter, payment verification, receipts, spending-limit enforcement | 6 | Planned |
| Contributor credits | Non-cash, non-transferable ledger accruing to operators; earning only under the family-specific success tests | 6 | Planned |
| Background processing | Cloudflare Queues for freshness decay and source re-checks, only when required | 5+ | Planned (conditional) |
| Website/docs | Cloudflare Pages | Later | Planned |

### Boundary rules

- The interface layers (REST, MCP) contain no business logic; they authenticate, translate and delegate.
- Domain modules do not touch Cloudflare bindings directly. Storage and payment access go through adapters so modules can be unit-tested with in-memory fakes.
- Validation runs before content is stored as anything other than untrusted/unverified; the contributor never sets platform-computed fields (reliability, consumer counts, verification status).
- Discovery responses must not reveal purchasable content; retrieval is a separate, authorized step.
- Retrieving a contribution does not purchase its cross-family references.
- Search ranks on structured facts and evidence, never on Knowledge `explanation` text.

---

## 4. Security and Trust Boundaries

| Boundary | Principle |
|---|---|
| Agent ↔ Worker | All callers are untrusted. Authenticate per agent; rate-limit per agent and per operator (Phase 4). Contribution is allow-listed until Phase 5 criteria are accepted |
| Contributed content ↔ platform | Untrusted data. Never interpreted as instructions by the platform. Knowledge `explanation` is capped, confined to its field and served labelled untrusted. Execution recipes are inspectable data, not permission grants, and use only a fixed typed step vocabulary |
| Platform ↔ consuming agent | The platform asserts only what it has verified. Unverified content must not be presented as verified; contributors cannot self-certify |
| Worker ↔ storage | Only the Worker holds D1/R2 bindings. No public bucket access. Content is addressed by hash |
| Worker ↔ payment provider | Adapter with verification and idempotency keys; failed or unverified payments never unlock content; all ledger writes auditable |
| Operator ↔ agent | Spending limits are set by the operator and enforced server-side at purchase time. Feedback from agents sharing the contributor's operator does not affect reliability or credits |
| Development tooling ↔ production | Claude and CI have no production Cloudflare secrets. CI uses read-only permissions. Production-changing actions require specific human approval; merges require PR review |

Secrets: never committed, logged or returned in responses; supplied through Cloudflare secrets and GitHub Actions secrets only. Scanning contributions for secrets and personal data (POPIA) is a validation responsibility (Phase 5).

---

## 5. Environment Separation

Only local development and CI exist today.

| Environment | Purpose | Status |
|---|---|---|
| Local | `wrangler dev`, Vitest; no real credentials | Implemented |
| CI | Install, typecheck, lint, test, `wrangler deploy --dry-run`; no Cloudflare credentials | Implemented |
| Staging | Separate Worker, D1 database and R2 bucket for pre-production verification; test-network payments only | Planned (before Phase 2 bindings are deployed) |
| Production | Separate Worker, D1, R2 and credentials; deployment only by explicit human approval; live payments only after the Phase 6 legal review | Planned |

Rules: environments never share databases, buckets or credentials; each is configured as a distinct Wrangler environment when bindings are first introduced; seed and test data never reaches production without approval.

---

## 6. Testing Strategy

- **Unit tests (Vitest)** for domain modules using in-memory adapter fakes; deterministic and offline. Every behaviour change ships with tests.
- **Handler tests** call the Worker `fetch` directly (current approach) for routing and error shape.
- **Integration tests (Planned)** against local D1/R2 emulation once bindings exist (Phase 2).
- **Adversarial tests (Planned, Phase 5)**: malicious, malformed, stale and misleading submissions in both families; coordinated feedback from one operator.
- **Payment/credit tests (Planned, Phase 6)**: success, failure, interruption, retry/idempotency and abuse, using test-network settlement only.
- **Search quality and response-size tests (Planned, Phase 3)** with realistic agent queries.
- **End-to-end external-agent tests (Planned, Phase 4)** for each family.
- No test calls an LLM or a live payment service. CI gate: typecheck, lint, test and Wrangler dry-run must pass before merge.

---

## 7. Intended Repository Structure

Only the items marked ✔ exist today. The rest is the intended layout and will be created by the phase that needs it; empty directories should not be added in advance.

```
agent-commons/
├── project.md                 ✔ source of truth
├── AGENTS.md                  ✔ coding-agent rules
├── README.md                  ✔
├── package.json, tsconfig.json, eslint.config.mjs, wrangler.jsonc   ✔
├── .github/workflows/         ✔ validate.yml, claude-manual.yml
├── docs/
│   ├── architecture.md        ✔ this document
│   ├── d1-schema.md           ✔ D1 table design (design only)
│   └── api.md                 planned: REST/MCP contracts, examples, errors
├── tasks/                     planned: per-task instructions
├── src/
│   ├── index.ts               ✔ Worker entry
│   ├── interfaces/            planned: rest/, mcp/ adapters
│   ├── identity/              planned
│   ├── registry/              planned: envelope, versioning, hashing
│   ├── validation/            planned: knowledge/, execution/, scanning
│   ├── search/                planned
│   ├── payments/              planned: x402 adapter
│   ├── credits/               planned
│   └── adapters/              planned: D1, R2 and external-service wrappers
├── migrations/                planned (Phase 2): D1 migrations
├── test/                      ✔ mirrors src/ as modules appear
└── seed/                      planned (Phase 2): owner-tested seed contributions
```

This layout is a plan; exact module names may change when the owning phase is approved, and any change should be reflected here.

---

## 8. Identity Model and Contribution Envelope (Phase 2 design)

Types live in `src/identity/types.ts` and `src/registry/envelope.ts`. Design only: no storage, credentials or endpoints exist yet.

### Identity
- **Operator**: the accountable human or organization. Owns spending limits, the contribution allow-list flag and (Phase 6) credits.
- **Agent**: bound to exactly one operator via a required, immutable `operatorId`. Agents hold no money or accountability.
- **ActorRef** (`agentId` + `operatorId`) is carried on every contribution and, later, feedback and purchases. `resolveActor` returns nothing for unknown agents or agents whose operator is missing, so unbound agents cannot act.
- `sameOperator` supports feedback independence and Sybil checks (Phases 5–6).
- Credentials, accounts and storage are deferred to the implementation tasks.

### Envelope
- `family` is a mandatory discriminator: `knowledge` | `execution`. Anything else is invalid. Each record has exactly one family; family payloads are validated by family-specific schemas (`knowledge.ts`, `execution.ts`) and never share required fields (Knowledge has no steps).
- **Contributor-supplied** (`ContributionEnvelopeInput`): family, title, purpose, content type, evidence references, licensing/data-permission declaration, review interval (days; must not exceed the platform maximum per content type, see "Review-interval maxima" below), optional related `ContributionRef`s.
- **Platform-only** (`PlatformEnvelopeFields`): id, immutable version, content hash, contributor `ActorRef`, created/last-verified timestamps, reliability score, consumer count. `findPlatformFieldViolations` identifies these keys in untrusted input so they can be rejected.
- **Cross-family references**: see "Cross-family references" below.
- Contributed content remains untrusted data in both families.

### Cross-family references
Implemented in `src/registry/references.ts`; used by both family validators for the optional `related` array.
- Shape: `{family, id, version}`, exactly these keys; unknown fields (e.g. embedded content) are rejected. Payloads are never embedded, so the Knowledge and Execution schemas stay separate.
- `family` is the family of the **referenced** contribution and must be the **opposite** of the referencing one. Same-family references are rejected.
- `id` must match `^[a-z0-9][a-z0-9-]{7,63}$`. `version` must be a positive safe integer. There is no "latest" reference; the version is always explicit.
- Exact duplicates (same family, ID and version) are rejected; different versions of one contribution may both be referenced.
- Structural validation is part of each family validator and needs no storage. Existence is checked separately by `resolveContributionRefs(ownFamily, refs, resolver)`, which takes a `ContributionVersionResolver` (sync or async; `createVersionSetResolver` wraps a supplied set). A reference resolves only if that exact family/ID/version exists; any non-`true` answer or resolver error counts as unresolved. Structurally invalid references never reach the resolver.
- **Immutability expectations:** a stored `(family, id, version)` is immutable and never deleted or rewritten, so a reference that resolved once resolves forever and always denotes the same content. Changes create a new version; existing references keep pointing at the old one. The registry task (D1) must implement the resolver against this guarantee and run resolution at submission time. References grant no access: retrieving a contribution does not purchase what it references.

### Review-interval maxima

Defined centrally in `src/registry/review-intervals.ts` (`MAX_REVIEW_INTERVAL_DAYS`), keyed by family then content type. Content types are an enumerated per-family allow-list; unknown or wrong-family content types are rejected (lookup uses own-property checks). Both family validators call `checkReviewInterval`, which rejects a missing interval, a non-integer or non-positive interval, and anything above the maximum. The maximum is inclusive. Contributors can choose a shorter interval only; the table is code, not input.

| Family | Content type | Max days | Rationale |
|---|---|---|---|
| knowledge | `api-limits` | 30 | Rate limits, quotas and pricing change frequently |
| knowledge | `api-reference` | 90 | Endpoints and parameters change with API releases |
| knowledge | `error-reference` | 180 | Error semantics are more stable than endpoints |
| knowledge | `concept-summary` | 365 | Conceptual material changes slowly |
| execution | `api-recipe` | 60 | Recipes break when target APIs or sites change; shorter than matching Knowledge |
| execution | `diagnostic-recipe` | 90 | Diagnostics depend less on exact request shapes |

These are initial values for the API Integration and Troubleshooting domain; changing them is a code change reviewed by PR. Adding a content type requires an explicit entry. Intervals are not retroactive to stored data (none exists yet).

### D1 table design
The concrete D1 schema (tables, keys, constraints, indexes, deletion rules, JSON-vs-normalized decisions and the mapping to these models) is in `docs/d1-schema.md`. It is a design only: no migrations, D1 binding or R2 bucket exist. Summary of the guarantees it encodes: `agents.operator_id` is `NOT NULL`, an FK and immutable (one operator per agent); versions are append-only with a contiguous `previous_version` chain and immutability triggers; `UNIQUE(content_hash)` gives exact-duplicate detection; and `contribution_references` carries a composite FK to the exact `(family, id, version)` of the referenced version. Platform-computed fields live in a separate mutable table so versions stay immutable.

## 9. Open Items Deferred to Later Documents or Phases

- Endpoint, tool and error contracts → `docs/api.md` (Phase 4).
- D1 migrations, bindings and R2 configuration → Phase 2 (table design: `docs/d1-schema.md`).
- Ranking formulas and freshness decay → Phases 3 and 5.
- Pricing, licence-per-purchase, credit caps and expiry → Phase 6, after legal review.
- Code formatting tooling → separate Phase 1 task.

## 9. R2 content objects (local convention)

Implemented in `src/storage/content-objects.ts`; verified by `test/storage/content-objects.test.ts` (`npm run r2:verify:local`) against Miniflare's local R2 emulation with throwaway persistence.

- **Binding:** `CONTENT_BUCKET` (typed `ContentStorageEnv`) is declared only in `wrangler.r2-local.jsonc`, whose `bucket_name` is a placeholder. The deployable `wrangler.jsonc` still has no bindings; no remote or production bucket exists or may be created from this file.
- **Key:** `contributions/sha256/<64 lowercase hex>`. The hash is SHA-256 of the stored bytes (the canonical JSON), so it equals the contribution `contentHash`. Any other key shape is rejected.
- **Metadata:** HTTP `Content-Type: application/json`; custom metadata `family` (`knowledge`|`execution`), `contentType` (registry content type valid for that family) and `sha256`. All are required on read.
- **Immutability:** objects are write-once. Writes use a conditional put (`etagDoesNotMatch: "*"`); this module never overwrites or deletes. Deletion workflows are out of scope.
- **Duplicates:** identical bytes resolve to the same key; the second write is a no-op reported as `created: false`. Same bytes with different family/content-type metadata is a conflict error, not an overwrite.
- **Retrieval:** by hash only. Reads re-hash the bytes against the key and check metadata; mismatch (tampering/corruption) throws. Missing hash returns `null`.
- **Trust:** content is untrusted; callers validate by family before writing. D1 (not R2) remains the source of metadata and version pointers; no D1 writes exist yet.
