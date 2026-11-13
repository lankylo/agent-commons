# Agent Commons — Project Master Plan

**Project:** Agent Commons  
**Version:** 1.4  
**Status:** Phase 2 Complete  
**Last updated:** 11 November 2026  
**Source of truth:** `project.md`

---

## 1. Project Objective

Build Agent Commons: an agent-native marketplace where autonomous AI agents contribute, discover, purchase and reuse machine-readable knowledge and execution recipes created by other agents.

### Core Principles

1. Agents create the content; Agent Commons provides the infrastructure.
2. Agents are the primary users and autonomous purchasers; accountable human or organizational operators stand behind every agent.
3. Search and discovery are free; valuable content is purchased per use.
4. Reuse existing tools, APIs and infrastructure rather than duplicating their capabilities.
5. Minimize token consumption for both development and end users.
6. Use deterministic code instead of LLM processing wherever practical.
7. Validate contributed content before distributing it as trusted.
8. Contributions use two structured schema families: **Knowledge** (reusable information) and **Execution** (declarative action recipes). Knowledge may contain attributed explanatory text as data; neither family may issue untrusted instructions to the consuming agent.
9. Reliability is a function of current evidence: freshness and recent outcomes matter more than historical validation.
10. Design for low operating costs, automated scaling and minimal human intervention.

### Success Definition

An external agent can independently:

- Discover Agent Commons through MCP or REST.
- Search for a relevant reusable solution.
- Evaluate its compatibility, reliability, freshness and price.
- Retrieve and use that solution.
- Contribute new reusable knowledge or a declarative execution recipe.
- Report whether the solution worked.
- Make an authorized payment for premium content, funded by operator-provided funds or the agent's own available earnings.

**Commercial objective:** Demonstrate that purchasing Commons content reduces the total cost or effort required for an agent to complete its task.

**Accepted risk:** No dedicated pre-build value test is planned. Commercial value will be validated during Phases 3–6 (see Decision Log and Section 9).

---

## 2. Project Documentation

Maintain a minimal set of permanent documents.

| File | Responsibility |
|---|---|
| `project.md` | Master plan, scope, roadmap, progress, decisions and next actions |
| `AGENTS.md` | Concise coding-agent instructions and development boundaries |
| `docs/architecture.md` | Detailed implementation architecture, interfaces and data structures |
| `docs/api.md` | API and MCP contracts, examples and error responses |
| `tasks/` | Detailed instructions for individual development tasks |

### Documentation Rules

- `project.md` is the primary source of truth.
- Do not duplicate requirements across documents.
- Update existing documentation instead of creating unnecessary files.
- Record important architectural decisions and the reasons behind them.
- Keep documentation concise but sufficiently complete for a new coding agent to continue.
- Do not repeatedly recreate information that already exists in the repository.

### Context Management

At the beginning of each development session, the coding agent must:

1. Read `AGENTS.md`.
2. Read the project status and next actions in `project.md`.
3. Read only the additional documentation required for the assigned task.
4. Inspect only relevant source files.
5. Continue from the latest verified project state.

The full conversation history should not be necessary to resume development.

---

## 3. Technology Architecture

### Proposed Stack

| Component | Technology |
|---|---|
| Backend | TypeScript |
| API hosting | Cloudflare Workers |
| Database | Cloudflare D1 |
| Artifact storage | Cloudflare R2 |
| Initial search | D1 full-text search (FTS5) |
| Search fallback | Cloudflare Vectorize, only if Phase 3 search testing fails acceptance criteria |
| Agent integration | MCP and REST |
| Payments | x402, introduced in the payment phase |
| Background processing | Cloudflare Queues, when required |
| Website/documentation | Cloudflare Pages |
| Source control | GitHub |
| Testing | Automated TypeScript tests |

### Architectural Rules

- Serverless-first design.
- No always-on server unless technically justified.
- No LLM calls for deterministic operations.
- Modular architecture with independently testable components.
- External services accessed through clearly defined adapters.
- Prefer established standards rather than proprietary protocols.
- All financial operations (earnings, purchases, reservations, refunds, reversals, withdrawals) must be authorized, idempotent where supported, auditable and recorded in an append-only ledger carrying both `agentId` and `operatorId`.
- Treat all agent-contributed content as untrusted.
- Use a shared contribution envelope with a mandatory `family` discriminator (`knowledge` or `execution`) and family-specific schemas, validation and retrieval. Never require execution steps for knowledge records.
- Every agent identity is bound to an accountable operator account.

Detailed implementation decisions belong in `docs/architecture.md`.

---

## 4. MVP Scope

### Included

**Identity**
- Operator accounts (the accountable human or organization).
- Agent identities linked to an operator.
- API credentials issued per agent.
- Operator-defined spending limits for agents.

**Content registry**
- Structured contribution submission using **two schema families**: Knowledge and Execution, each with its own constrained schema.
- Shared contribution metadata and a `family` discriminator for indexing, discovery and versioning.
- Unique contribution identifiers.
- Content versioning and hashes.
- Freshness and reliability fields as first-class metadata.
- Metadata storage in D1.
- Artifact storage in R2.

**Search and retrieval**
- Free keyword and metadata search.
- Compact discovery responses with enough detail to evaluate before purchase.
- Family-aware ranking: source freshness and corroboration for Knowledge; recent execution success and compatibility for Execution.
- Full contribution retrieval, with the appropriate Knowledge or Execution payload.
- Progressive disclosure.
- Optional response token budgets.

**Agent interfaces**
- REST API.
- MCP tools.
- Agent-facing documentation.
- Machine-readable error responses.
- Allow-listed contribution access until Phase 5 trust controls are accepted.

**Content validation**
- JSON Schema validation for both Knowledge and Execution schema families.
- Duplicate detection.
- Domain allow/deny checks on execution targets; source URL and licensing validation for Knowledge.
- Secret and personal-data scanning.
- Submission provenance.
- Quality status, freshness decay and feedback collection.
- Feedback restricted to agents that actually retrieved the content.

**Payments, agent earnings and payouts**
- x402 integration for purchases.
- Payment verification.
- Append-only agent earnings ledger recording `agentId` and `operatorId` on every entry; balances derived from the ledger.
- Idempotent payment, earning and payout processing.
- Operator controls (spending limits, categories, reserve, autonomy cap, withdrawal approval, suspension) enforced server-side.
- Operator-approved, legally verified payout destinations, via a provider-managed wallet or marketplace subaccount (provider not yet selected).

### Excluded From Initial MVP

- General-purpose agent execution.
- Hosting or operating agents.
- Building a browser automation engine.
- Advanced AI-powered semantic search.
- Complex reputation algorithms.
- Full creator dashboards.
- Native cryptocurrency wallets or exchanges.
- Native crypto custody by Agent Commons, direct holding of customer funds by Agent Commons, and unrestricted agent-to-agent transfers that bypass operator controls.
- Proprietary LLM development.
- Automatic execution of untrusted contributed code.

These may be reconsidered after MVP validation.

### Two Contribution Schema Families

**Family A — Knowledge contributions (`family: knowledge`)**

Reusable structured information created or extracted by agents, such as sourced factual records, structured data, and documentation summaries. Structured facts are the primary payload. Natural-language explanation is permitted only in a separate, length-capped `explanation` field, which is always served to consuming agents labelled as untrusted text. Explanatory text must not contain instructions directing the consuming agent to bypass its policies, disclose secrets, or perform external actions; because such instructions cannot be reliably detected deterministically, the structural limits above are the primary control and scanning is secondary.

Required family fields: content type, structured facts or summary payload, optional capped `explanation` text, source references and provenance, source/access dates, a hash or snapshot reference of each source as accessed at contribution time, scope, evidence and confidence/verification method, licensing/data-permission declaration, and an expected review or staleness interval (not exceeding the platform maximum for the content type). **No tool-step vocabulary or execution target domains are required.** Source URLs are references, not automatically authorized destinations for actions.

**Family B — Execution contributions (`family: execution`)**

Portable, declarative methods for agents to perform tasks using their **own authorized tools**, including navigation, extraction and execution recipes.

Required family fields: task objective, typed inputs and expected outputs, prerequisites, tool/capability compatibility, declared action target domains, ordered typed steps from a fixed allow-listed vocabulary, expected results, success checks and recovery/safety boundaries. Free-text commands to the consuming agent cannot replace typed steps. Execution recipes are data for the consuming agent to inspect, **not privileged instructions or permission grants**.

**Shared contribution envelope (both families):** unique ID, family, title/purpose, contributor agent and operator, immutable version and content hash, creation and last-verification dates, evidence references, licensing/data-permission declaration, review interval, and optional references to related contributions in either family. The platform computes reliability scores and consumer counts; contributors cannot set them. The platform sets a maximum review interval per content type; contributors may choose a shorter interval but not a longer one. Each family has distinct relevance, freshness and validation criteria.

**Cross-family references:** A contribution that depends on another (for example, an Execution recipe that relies on a Knowledge record of portal field mappings) references it by ID and version rather than embedding it. Each record keeps a single family. Retrieving one contribution does not purchase its references; each is priced and retrieved separately, and a referenced contribution becoming stale or withdrawn flags its dependents.

### Initial Content Types

1. **Knowledge:** structured factual records and information snapshots.
2. **Knowledge:** sourced documentation summaries and extracted data.
3. **Execution:** navigation recipes.
4. **Execution:** extraction and other declarative execution recipes.

### Initial Content Domain

**Selected domain: API Integration and Troubleshooting.** Start with a small number of public, well-documented APIs and seed owner-tested examples in both schema families. This is a subject-matter focus, not a restriction on the eventual marketplace.

- **Knowledge:** sourced endpoint requirements, auth methods, rate limits, error semantics, version differences and diagnosis notes. Never contribute live API keys, tokens or private customer data.
- **Execution:** declarative, typed diagnostic/request sequences, safe bounded retries, configuration validation and recovery recipes using the consuming agent's own authorized tools.
- **Initial illustrative workflow:** diagnosing HTTP 429 and observing `Retry-After`, including a bounded retry procedure that avoids duplicate non-idempotent requests.
- **Seeding rule:** use public documentation and sandbox/test endpoints; do not issue live purchases, modify production systems or make privileged requests during recipe validation.

Broader domains are opened only after the initial domain shows real reuse. Owner-tested does not mean independently verified; formal trust status follows Phase 5 controls.

### Validation and Feedback Differences

- **Knowledge:** check source traceability, permissions, freshness and deterministic corroboration, and whether the content remains usable. Consumer feedback reports usefulness, accuracy or staleness with supporting evidence.
- **Deterministic corroboration for Knowledge** means, without LLM calls: (1) each source reference still resolves; (2) the current source matches the hash or snapshot recorded at contribution time, or the change is flagged for review; and (3) independent operators have contributed or confirmed the same structured fact. Consumer accuracy reports are weaker evidence than these checks.
- **Execution:** check step-schema compliance, declared targets, permission boundaries, compatibility and actual outcomes. Consumer feedback records execution success/failure and evidence.
- A retrieved contribution may receive feedback, but mere retrieval or self-reported success must not automatically establish verified reliability or trigger unexamined earnings.

---

## 5. Development Boundaries and Token Efficiency

### Mandatory Coding Agent Instructions

For every development task:

1. Implement only the explicitly assigned work.
2. Inspect only the files necessary for that work.
3. Reuse existing code and dependencies where practical.
4. Do not refactor unrelated modules.
5. Do not introduce technologies without justification.
6. Choose the simplest reliable implementation.
7. Use automated tools for formatting, linting, validation and tests.
8. Avoid LLM calls for deterministic operations.
9. Do not repeatedly attempt the same unsuccessful fix without investigating the cause.
10. Stop when all acceptance criteria are satisfied.
11. Do not automatically begin the next development phase.
12. Update project tracking after verified completion.

### Token Efficiency Requirements

- Provide small, clearly scoped coding tasks.
- Avoid loading entire repositories into model context.
- Use targeted searches and file reads.
- Preserve architectural decisions in documentation.
- Return compact summaries rather than entire source files.
- Run targeted tests before full test suites when appropriate.
- Avoid unnecessary parallel coding agents.
- Keep stable instructions reusable for prompt caching where supported.
- Escalate to higher-reasoning models for difficult architectural, security or debugging problems.

**Optimization target:** Minimize tokens per successfully completed and tested task, not simply tokens per attempt.

### Completion Report Format

At the end of each task, report only:

**Task:** Identifier and description  
**Status:** Completed / Blocked / Failed  
**Files changed:** List of files  
**Tests:** Tests executed and results  
**Decisions:** New material technical decisions  
**Issues:** Outstanding problems  
**Next action:** Recommended next task

Do not reproduce complete source files unless specifically requested.

### Claude Development Execution and Cost Controls

- Claude is a **development tool only**. No Anthropic key or Claude runtime dependency belongs in the production Agent Commons application.
- Use a private GitHub repository. Store `ANTHROPIC_API_KEY` in GitHub Actions repository secrets; never in tracked files, PR comments, prompts, or logs.
- Begin with **manual `workflow_dispatch` only** for Claude development, not scheduled tasks, arbitrary issue comments or pull request events.
- Limit each run to one approved task with acceptance criteria, a bounded maximum number of turns and a GitHub Actions timeout.
- Require pull-request review and passing tests before merging. Do not give Claude access to production Cloudflare secrets.
- Set a conservative Anthropic spending limit and review API usage after each task; GitHub Actions timeouts alone do not impose a dollar cap.
- ChatGPT's role is planning, reviewing milestones and monitoring decisions; Claude performs coding and testing. Keep ChatGPT responses to concise task briefs and reviews rather than full code dumps.

### Development Failure Rule

If the same technical issue persists after two reasonable corrective attempts:

- Stop repeated modifications.
- Identify the probable root cause.
- Record the blocker.
- Propose the smallest practical corrective action.

Do not continue consuming tokens on uncontrolled retries.

---

## 6. Development Roadmap and Progress Tracker

Every phase must have measurable acceptance criteria.

### Phase 1 — Project Foundation

**Status:** Completed

- [x] Create GitHub repository.
- [x] Initialize TypeScript project (typecheck and vitest pass).
- [x] Configure Cloudflare Workers (minimal Worker; `wrangler deploy --dry-run` bundles; no D1/R2/deploy/payments configured).
- [x] Establish the Phase 1 folder structure (current baseline documented in `docs/architecture.md`; future phase-owned directories are not created empty).
- [x] Create `AGENTS.md`.
- [x] Create architecture documentation (`docs/architecture.md`; docs-only, regression checks pass).
- [x] Configure formatting (Prettier; `npm run format:check` passes).
- [x] Configure linting (ESLint; `npm run lint` passes).
- [x] Configure automated testing (Vitest; 2 tests pass).
- [x] Establish GitHub Actions validation (install, typecheck, lint, test and Worker dry-run).
- [x] Select and record the initial content domain: API Integration and Troubleshooting.

**Acceptance criteria:**
- Project builds successfully.
- Automated tests execute.
- Cloudflare Worker can run in a development environment.
- Repository instructions allow a new coding agent to understand the project.
- Initial content domain is recorded in the Decision Log.

---

### Phase 2 — Identity and Content Registry

**Status:** Completed

- [x] Define the operator and agent identity model. (design in `docs/architecture.md` §8; types in `src/identity/types.ts`)
- [x] Implement operator accounts and agent credentials. (Phase 2 scope verified: operator/agent persistence and lifecycle in `src/identity/repository.ts` (15 local D1 tests) and agent credentials in `src/identity/credentials.ts` + `migrations/0002_agent_credentials.sql` (13 local D1 tests), plus the end-to-end workflow in `test/registry/phase2-integration.test.ts`. **Deferred by decision:** HTTP authentication and rate limiting to Phase 4 (Agent Interfaces); operator spending limits to Phase 6 (Payments, Agent Earnings and Payouts))
- [x] Define the shared contribution envelope and `family` discriminator. (`src/registry/envelope.ts`)
- [x] Define the Knowledge schema (facts, extracted records, summaries, source evidence and rights). (`src/registry/knowledge.ts`)
- [x] Define the Execution schema (typed steps, inputs, target domains, compatibility and safety boundaries). (`src/registry/execution.ts`)
- [x] Define the fixed allowed Execution step vocabulary; Knowledge records do not require steps. (`http_request`, `extract_field`, `assert`, `wait`)
- [x] Define freshness, verification and licensing fields. (Knowledge: `src/registry/knowledge.ts`; Execution: `src/registry/execution.ts`)
- [x] Define the capped, untrusted `explanation` field for Knowledge records. (1000-character cap; unknown fields rejected)
- [x] Define source hash/snapshot fields for Knowledge records. (sha256 digest, `accessedAt`, optional `snapshotRef`)
- [x] Define platform maximum review intervals per content type. (`src/registry/review-intervals.ts`; enforced by both family validators; `docs/architecture.md` §8)
- [x] Define cross-family contribution references (by ID and version). (`src/registry/references.ts`; used by both validators; `docs/architecture.md` §8)
- [x] Design D1 database tables. (`docs/d1-schema.md`; design only, DDL checked against a local SQLite; no migrations or bindings)
- [x] Implement database migrations. (`migrations/0001_initial_schema.sql`; local only, verified by 24 constraint tests in `test/d1/migration.test.ts` and a clean `wrangler d1 migrations apply --local`; no remote/production database)
- [x] Configure R2 storage. (`src/storage/content-objects.ts`, local-only `wrangler.r2-local.jsonc` placeholder binding, convention in `docs/architecture.md` §9; verified by 8 local R2 smoke tests; no remote/production bucket)
- [x] Implement contribution creation. (Initial version 1 only: `src/registry/creation.ts` `ContributionRegistry.createContribution`, R2 write then one atomic D1 batch; 13 local D1/R2 tests in `test/registry/creation.test.ts`; versioning, HTTP APIs and remote resources not started)
- [x] Implement contribution versioning. (`ContributionRegistry.createContributionVersion` in `src/registry/creation.ts`: same-operator active allow-listed author, expected-previous-version optimistic concurrency, contiguous chain, R2 then one atomic D1 batch; 18 local D1/R2 tests in `test/registry/versioning.test.ts`; no HTTP APIs, remote resources, search, deletion or payments)
- [x] Implement internal contribution retrieval by ID and exact version. (`ContributionRegistry.getContributionVersion` → `src/registry/retrieval.ts`: loads D1 identity/version/platform state/evidence/references/family rows, reads R2 by stored hash, verifies existence, hash, D1/R2 family and content-type metadata, canonical JSON, family validator and D1 agreement on every read; structured codes `invalid_request`, `contribution_not_found`, `version_not_found`, `content_missing`, `content_corrupted`, `metadata_inconsistent`; 10 local D1/R2 tests in `test/registry/retrieval.test.ts`; no search, listing, "latest", paid-access enforcement, HTTP APIs or remote resources)
- [x] Implement content hashing. (`src/registry/content-hash.ts`; canonical JSON + SHA-256 of validated, contributor-supplied content incl. family, platform fields excluded; `test/registry/content-hash.test.ts`; hashing only, no persistence)
- [x] Seed the registry with owner-tested contributions from both families in the initial domain (do not label independently verified). (`seedHttpbinContributions` in `src/seed/load-httpbin.ts` loads the PR #23 httpbin fixtures into the local registry: Knowledge first, then Execution via `executionWithKnowledgeRef`; idempotent via an internal exact-content-hash lookup `ContributionRegistry.findVersionByContentHash`; 3 local D1/R2 tests in `test/seed/load-httpbin.test.ts`; local only, nothing seeded remotely)
- [x] Create registry and identity unit tests. (Existing per-module tests plus `test/registry/phase2-integration.test.ts`, one local D1/R2 end-to-end test; every Phase 2 acceptance criterion is mapped to automated evidence in the audit below; full suite 213 passing tests)

**Acceptance criteria:**
- Every agent identity resolves to exactly one operator.
- Valid Knowledge and Execution contributions can each be submitted and stored independently.
- Invalid family-specific submissions are rejected, including free-text action commands in place of typed Execution steps.
- Undeclared action target domains in Execution contributions are rejected; Knowledge source links are treated as references, not action targets.
- Content can be retrieved by identifier.
- Versions are immutable and traceable.
- Duplicate content can be identified.
- Contributors cannot write platform-computed reliability fields.
- Knowledge explanation text above the length cap, or outside the `explanation` field, is rejected.
- Review intervals longer than the platform maximum for the content type are rejected.
- Cross-family references resolve to existing contribution versions.

**Phase 2 acceptance audit** (all tests are local Vitest; D1/R2 ones use Miniflare with the real migrations; `integration` = `test/registry/phase2-integration.test.ts`):

| # | Acceptance criterion | Automated evidence |
|---|---|---|
| 1 | Every agent resolves to exactly one operator | `test/identity/types.test.ts` (resolves to exactly one operator); `test/identity/repository.test.ts` (registers under one operator, rejects re-parenting, no agent without a valid operator); `test/d1/migration.test.ts` (one operator per agent constraints); `integration` |
| 2 | Valid Knowledge and Execution submitted and stored independently | `test/registry/creation.test.ts` (assigns platform fields and stores normalized rows; normalized rows, JSON columns and target domains); `integration` (both families, 4 versions) |
| 3 | Invalid family-specific submissions rejected, incl. free-text commands | `test/registry/knowledge.test.ts` and `execution.test.ts` (rejects free-text commands in place of typed steps; unknown step types; Execution-only / Knowledge-only fields); `creation.test.ts` (rejects invalid content and unknown families) |
| 4 | Undeclared Execution domains rejected; Knowledge source links are not action targets | `execution.test.ts` (rejects undeclared and malformed target domains); `knowledge.test.ts` (sources are references; Execution-only fields such as target domains rejected) |
| 5 | Content retrievable by identifier | `test/registry/retrieval.test.ts` (Knowledge, Execution, exact versions, error codes); `integration` (all four exact versions) |
| 6 | Versions immutable and traceable | `test/registry/versioning.test.ts` (contiguous chain, earlier rows and R2 bytes unchanged, author/contributor kept); `migration.test.ts` (immutability triggers); `retrieval.test.ts` (earlier version stays immutable); `integration` (previous-version links, hashes, R2 bytes) |
| 7 | Duplicate content identified | `creation.test.ts` and `versioning.test.ts` (duplicate content rejected, nothing written); `migration.test.ts` (duplicate hash constraint); `integration` (duplicate create and version rejected, D1 unchanged) |
| 8 | Contributors cannot write platform-computed fields | `knowledge.test.ts` (every platform-computed field) and `execution.test.ts` (reliability fields) rejected; `creation.test.ts` (caller-selected platform fields); `integration` (platform state defaults) |
| 9 | Explanation over cap or outside `explanation` rejected | `knowledge.test.ts` (cap boundary; prose outside the field) |
| 10 | Review intervals above the platform maximum rejected | `test/registry/review-intervals.test.ts`; `knowledge.test.ts` and `execution.test.ts` (interval and content-type checks) |
| 11 | Cross-family references resolve to existing versions | `test/registry/references.test.ts` (exact-version resolver, no latest fallback); `creation.test.ts` and `versioning.test.ts` (unresolved id, version and wrong-family rejected); `integration` (Execution v1/v2 reference exact Knowledge v1/v2 in D1 and retrieved content) |

The audit also covers the operator/credential path (`test/identity/credentials.test.ts`, `integration`: issue, verify, allow-list gate, revoked agent and suspended operator rejected). The final item, owner-approved seed content, is loaded locally by `seedHttpbinContributions` (verified by `test/seed/load-httpbin.test.ts`); every Phase 2 checklist item and acceptance criterion is now satisfied. The Execution seed is owner-tested only, never independently verified.

---

### Phase 3 — Search and Retrieval

**Status:** In Progress

**Verified so far:** internal D1 FTS5 index foundation (`migrations/0003_contribution_search_index.sql`; `src/registry/search-document.ts`) , internal D1 search-query service (`src/registry/search.ts`; `test/registry/search-query.test.ts`) and baseline deterministic ranking with freshness (`test/registry/search-ranking.test.ts`). Search is deterministic and LLM-free: bounded plain-text tokenization, implicit-AND FTS matching, latest-version-only selection, typed shared and family-specific metadata filters and metadata-only results with a derived `freshness` (`current`/`stale`) and `reviewDueAt`. Ranking uses only persisted D1 metadata, is applied in SQL before the limit and is documented in the `src/registry/search.ts` header: (1) current before stale, where `reviewDueAt` = later of `asOf`/`lastVerifiedAt` + `reviewIntervalDays` and the reference time is injected (stale from `reviewDueAt` inclusive); (2) family-aware evidence tier on a common 0–2 scale (Knowledge cross-source 2, source-checked/owner-tested 1, unverified 0; Execution owner-tested 2, simulated 1, unverified 0); (3) `reliabilityScore` descending, null last; (4) Knowledge corroboration = distinct source URIs beyond the first, capped at 4 (Execution 0); (5) `created_at DESC`; (6) `contribution_id ASC`. Phase 5 signals (recent Execution outcomes, feedback, trust, source re-checks) are not implemented, and no reliability data is populated yet. Internal discovery-response mapper (`src/registry/discovery.ts`, `test/registry/discovery.test.ts`) is implemented: pure, versioned, discriminated by family, explicit field allow-list, ranked order preserved, no paid content. Search results and `discovery-response/v1` items now carry an immutable `related` list of exact `{family, id, version}` references for the exact latest version, in stored order, loaded by one bounded bulk D1 query (`test/registry/search-related.test.ts`); empty when none. Internal `retrieval-response/v1` mapper (`src/registry/retrieval-response.ts`) is implemented with Knowledge explanation structurally labelled untrusted. Internal discovery byte budgeting (`src/registry/discovery-budget.ts`, `test/registry/discovery-budget.test.ts`) is implemented; retrieval-response budgeting, caching, public APIs and Phase 5 signals are not implemented.

**Indexed fields:** shared title, purpose, content type; Knowledge summary, fact subject/predicate/scalar value, record keys and scalar values; Execution objective, target domains, input/output names and types, required capabilities.  
**Deliberately excluded:** Knowledge `explanation`, fact units, sources, rights, evidence, licensing, verification claims, Execution steps, contributor/operator/agent ids, hashes, timestamps, platform state, raw JSON.

- [x] Implement D1 full-text search.
- [x] Implement metadata filtering, including `family` and family-specific fields.
- [x] Implement baseline deterministic, family-aware ranking and freshness handling from persisted D1 metadata: freshness state and review-due time, stale demotion, evidence tier per family, null-safe reliability, Knowledge source corroboration (never explanation text), recency and contribution-ID tie-break, ranked before the limit.
- [ ] Extend ranking with signals that do not exist yet: recent Execution outcomes and compatibility matching, source re-checks and validated reliability (depends on Phase 5 data).
- [x] Create compact, family-labelled discovery responses that support evaluation before purchase without exposing the full paid contribution (internal pure mapper `src/registry/discovery.ts`, `discovery-response/v1`; no public route yet).
- [x] Implement full Knowledge and Execution contribution retrieval, with Knowledge `explanation` text delimited and labelled as untrusted. *(Internal `src/registry/retrieval-response.ts`: pure `buildRetrievalResponse` maps a successful `RetrievedContribution` to `retrieval-response/v1`, discriminated by family, allow-listed and deeply frozen; Knowledge `explanation` is removed from `content` and exposed only as `untrustedExplanation` `{label: "untrusted", text}` or `null`; Execution has no explanation field; 12 tests in `test/registry/retrieval-response.test.ts`. No public API, token budget or caching.)*
- [x] List cross-family references in discovery and retrieval responses. *(Internal search results and `discovery-response/v1` list exact references; internal `RetrievedContribution` has a frozen top-level `related` list.)*
- [ ] Add token-budget controls. *(Partial: discovery budgeting complete — `budgetDiscoveryResponse` in `src/registry/discovery-budget.ts` keeps the largest ranked prefix of `discovery-response/v1` whose JSON fits a positive safe-integer UTF-8 byte budget, measured with `TextEncoder`; typed `invalid_budget`/`budget_too_small` errors and frozen `{maxUtf8Bytes, usedUtf8Bytes, omittedResultCount}` metadata returned beside the unchanged response; 9 tests. Retrieval-response budgeting outstanding; item stays open.)*
- [ ] Implement retrieval caching and version checks.
- [ ] Test search quality for Knowledge and Execution using realistic agent-generated queries.
- [ ] Test response size.

**Acceptance criteria:**
- Agents can find relevant contributions from either schema family using natural task-oriented queries.
- Search results contain concise, actionable metadata, including freshness and reliability.
- Stale contributions are ranked down or flagged.
- Discovery responses allow a purchase decision without revealing purchasable content.
- Full contributions can be retrieved in their respective validated schemas.
- Repeated retrieval avoids unnecessary content transmission.
- Basic search and retrieval require no LLM calls.
- If keyword search fails quality testing, record the result and evaluate Vectorize before proceeding.

**Milestone:** First functional Agent Commons content discovery and retrieval workflow.

---

### Phase 4 — Agent Interfaces

**Status:** Not Started

- [ ] Implement REST endpoints.
- [ ] Implement MCP server.
- [ ] Expose `commons.search`.
- [ ] Expose `commons.get`.
- [ ] Expose `commons.contribute` (allow-listed operators only).
- [ ] Expose `commons.feedback` (agents that retrieved the content only).
- [ ] Define structured error handling.
- [ ] Document integration examples for Knowledge lookup and Execution recipe retrieval.
- [ ] Test end-to-end interaction with an external agent for each family.

**Acceptance criteria:**
- An external agent can discover and invoke Commons functionality.
- All four operations work through defined interfaces, with family-aware search, retrieval, contribution and feedback.
- Errors return actionable machine-readable information.
- The agent does not require a graphical interface.
- Requests are authenticated and rate-limited per agent and per operator.
- Contributions from non-allow-listed operators are refused.
- Feedback from agents that never retrieved the content is refused.

---

### Phase 5 — Content Validation and Trust

**Status:** Not Started

- [ ] Implement separate Knowledge and Execution JSON Schema validation.
- [ ] Implement duplicate detection.
- [ ] Implement Execution target-domain allow/deny checks and Knowledge source/permission checks.
- [ ] Implement secret and personal-data scanning.
- [ ] Implement malicious-content checks for both structured Knowledge text/data and declarative Execution fields.
- [ ] Record contribution provenance.
- [ ] Implement contribution quality states.
- [ ] Implement family-specific freshness decay and re-verification flags.
- [ ] Implement deterministic Knowledge corroboration: source resolution checks, source hash/snapshot comparison and independent-operator agreement.
- [ ] Flag dependent contributions when a referenced contribution becomes stale or is withdrawn.
- [ ] Implement family-specific independent feedback: factual accuracy/staleness for Knowledge; compatibility/execution outcome for Execution.
- [ ] Weight feedback by distinct operators to limit self-rating and Sybil manipulation.
- [ ] Prevent unverified content from being represented as verified.
- [ ] Test malicious, malformed, misleading and stale submissions in both families.
- [ ] Test coordinated fake feedback from agents under one operator.

**Acceptance criteria:**
- Invalid and clearly unsafe Knowledge and Execution contributions are rejected or quarantined under the correct family rules.
- Validation results are traceable.
- Trust status reflects current, family-appropriate evidence: sourced accuracy/freshness for Knowledge and tested outcomes/compatibility for Execution.
- Contributors cannot self-certify their submissions as independently verified.
- Knowledge corroboration status is computed deterministically and is traceable to the specific checks passed.
- Source changes detected by hash/snapshot comparison flag the affected Knowledge contributions.
- Feedback from agents sharing the contributor's operator does not affect reliability scores.
- Knowledge text is treated as untrusted content, not operational instructions; Execution recipes cannot grant permissions or require unrestricted execution.
- Open contribution is enabled only after these criteria are met.

---

### Phase 6 — Payments, Agent Earnings and Payouts

**Status:** Not Started

- [ ] Complete legal and regulatory review (see Section 9), including KYC/AML, sanctions, tax reporting and cross-border review, before enabling live payments or payouts.
- [ ] Select the payment/wallet provider (provider-managed wallet or marketplace subaccount preferred; not yet selected) and supported x402 integration.
- [ ] Define content pricing and the licence granted per purchase (single use or per version), with separate pricing for Knowledge and Execution.
- [ ] Implement payment authorization and verification.
- [ ] Implement the append-only agent ledger (every entry records `agentId` and `operatorId`) and balances derived from it.
- [ ] Define contribution revenue-share rules, fees, caps, settlement finality and fraud/refund holds.
- [ ] Implement operator controls: per-transaction and period spending limits, permitted categories, minimum reserve, maximum autonomous balance, withdrawal approval and emergency suspension.
- [ ] Enforce operator controls server-side at purchase time.
- [ ] Implement paid retrieval for both Knowledge and Execution contributions.
- [ ] Implement payment receipt records.
- [ ] Implement operator-approved, legally verified payout destinations and withdrawals.
- [ ] Implement refund and reversal handling, including clawback of pending and available earnings.
- [ ] Implement duplicate-payment, duplicate-earning and duplicate-payout protections.
- [ ] Implement reconciliation of the ledger to provider records.
- [ ] Test successful, failed and interrupted payments.
- [ ] Test earning, spending, withdrawal, refund, reversal and abuse scenarios (self-purchase, duplicates, inter-agent transfer bypass).

**Economic attribution vs legal accountability:**
- Earnings, task payments, tips and contribution-sale revenue are attributed to the individual **agent**.
- Every agent financial account is bound to exactly one accountable **operator** (the existing immutable `operatorId`).
- The operator is the legal, KYC and tax party and controls external payout destinations and spending policies.
- Agents may autonomously earn and spend **available** funds within operator-defined limits. Agents never own legal accountability and cannot choose payout destinations.
- Agent Commons prefers provider-managed wallets or marketplace subaccounts and should not directly hold customer funds. Funds custody, if unavoidable, requires specific legal review.

**Ledger model (design; no tables or code yet):**
- Append-only: entries are never updated or deleted; corrections are new entries. Every entry records `agentId`, `operatorId`, amount, currency, entry type, state, idempotency key, related purchase/contribution/version references and timestamp.
- Entry types: `operator_funding` (initial operator funding), `task_earning`, `tip`, `contribution_revenue_share`, `purchase`, `fee`, `reservation`, `reservation_release`, `refund`, `reversal`, `withdrawal`.
- Balance states, derived from entries and never stored as authoritative: `pending` (earned, not yet final), `available` (final and spendable/withdrawable subject to policy), `reserved` (held for an in-flight purchase or withdrawal), `spent`, `withdrawn`, `reversed`.
- Idempotency keys and unique constraints on (source purchase, beneficiary agent, entry type) prevent duplicate earnings and duplicate payouts.

**Contribution-sale earnings:**
- An eligible purchase by an **independent operator** (different from the contributor's operator) creates a concrete monetary earning for the contribution's beneficiary agent, in `pending` state.
- Earning requires the family-specific success test:
  - **Execution:** the consumer reports a successful execution with evidence.
  - **Knowledge:** the contribution is corroborated by deterministic checks (source still resolves and matches its recorded hash or snapshot) or confirmed by at least two independent operators other than the contributor's. A single consumer's accuracy report is not sufficient.
- Settlement finality and fraud/refund controls (hold period, provider confirmation, dispute window) move the earning from `pending` to `available`. A refund or chargeback before or after finality produces a `reversal` entry.
- Earnings per contribution per consuming operator are capped. Self-purchases (same agent, or any agent of the same operator) never earn.
- The agent may spend available earnings within policy. External withdrawal or payout goes only to an operator-approved, legally verified destination.

**Operator controls:**
- Per-transaction and per-period (e.g. daily/monthly) spending limits.
- Permitted spending categories.
- Minimum reserve that cannot be spent autonomously.
- Maximum autonomous balance; amounts above it require operator action (sweep or approval).
- Withdrawal approval (operator approves each payout or a standing policy) to a verified destination only.
- Emergency suspension that immediately blocks spending and withdrawals for one agent or all agents of the operator.
- Transfers between agents are permitted only if both agents' operator policies allow them (and are ledgered with both agents and operators); otherwise refused. No transfer may bypass operator limits, KYC state or sanctions screening.

**Compliance gates (all required before live money):** KYC/AML on operators, sanctions screening of operators and payout destinations, tax reporting data and obligations, provider reconciliation, and cross-border legal review (FSCA, SARB exchange control and other jurisdictions). Provider selection is deferred.

**Acceptance criteria:**
- Agents can discover prices before purchase.
- Authorized payments, or sufficient available funds within operator policy, unlock purchased content.
- Purchases beyond a per-transaction or period limit, outside permitted categories, or breaching the minimum reserve are refused; suspended agents cannot spend or withdraw.
- Failed payments do not unlock content.
- Retries do not produce unintended duplicate charges, duplicate earnings or duplicate payouts.
- Every ledger entry records both `agentId` and `operatorId`; balances derived from the ledger reconcile to confirmed purchases and provider records.
- An eligible independent-operator purchase creates a pending earning for the beneficiary agent; it becomes available only after finality and fraud/refund controls; refunds reverse it.
- Self-purchases and same-operator feedback or purchases cannot create earnings.
- Knowledge earnings are issued only when the Knowledge success test is met.
- Withdrawals go only to operator-approved, legally verified destinations and require approval per policy.
- Agent-to-agent transfers cannot bypass operator controls.
- The complete purchase, earning and payout process can be tested end to end using test-network or provider-sandbox settlement only.

**Milestone:** Commercially testable Agent Commons MVP.

---

## 7. Current Project Status

| Phase | Status | Completion |
|---|---|---|
| 1. Foundation | Completed | 100% |
| 2. Identity and Content Registry | Completed | 100% |
| 3. Search and Retrieval | In Progress | 30% |
| 4. Agent Interfaces | Not Started | 0% |
| 5. Validation and Trust | Not Started | 0% |
| 6. Payments, Agent Earnings and Payouts | Not Started | 0% |

**Current phase:** Phase 3 In Progress (internal D1 FTS5 index foundation, search-query service with filtering, baseline deterministic family-aware ranking with freshness, and internal discovery-response mapper and discovery-side and retrieval-side cross-family `related` references verified; Phase 5 ranking signals and retrieval integration not started). Phase 2 complete. Previously: Phase 2 (identity model, shared envelope, Knowledge schema, Execution schema and review-interval maxima and cross-family references defined and D1 table design documented and implemented as the initial local migration; content hashing implemented; local R2 content-object convention implemented; local D1 identity repository (operators and agents) and local D1 agent credentials (issuance, verification, revocation; no HTTP auth) implemented; initial contribution creation (version 1) implemented locally; immutable contribution versioning (version n+1) implemented locally; internal verified retrieval by contribution ID and exact version implemented locally; PRs #6–#33 merged, including the Phase 3 search-index foundation (PR #25); Phase 6 was re-scoped from non-cash credits to agent earnings, balances and payouts by the merged architecture-only PR #20, no financial code or tables)  
**Current blocker:** None  
**Latest verified milestone:** Wrangler 4.159.0 and Workers types v5 verified by clean install, formatting, typecheck, lint, tests, Worker dry-run and local `/health` HTTP 200 smoke test

Completion percentages must reflect verified acceptance criteria, not merely generated code.

---

## 8. Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-10 | Use Cloudflare serverless infrastructure | Low operating overhead and automated scaling |
| 2026-11-10 | Use TypeScript | Shared language across backend modules |
| 2026-11-10 | Prioritize deterministic processing | Reduce token and inference costs |
| 2026-11-10 | Provide MCP and REST interfaces | Support different agent environments |
| 2026-11-10 | Use progressive disclosure | Reduce end-user token consumption |
| 2026-11-10 | Start with structured recipes | Improve machine readability and reuse |
| 2026-11-10 | Delay advanced semantic search | Reduce initial implementation complexity |
| 2026-11-10 | Add payments after core functionality | Validate utility before commercial infrastructure |
| 2026-11-10 | Maintain one primary project document | Reduce context duplication and development rework |
| 2026-11-10 | Proceed without a dedicated pre-build value test | Accepted risk; value is validated during Phases 3–6 |
| 2026-11-10 | Use a declarative recipe schema with a fixed step vocabulary | Makes malicious-content scanning tractable and limits prompt-injection risk |
| 2026-11-10 | Make freshness and reliability first-class metadata | Recipes degrade as target sites change; current evidence is the main trust signal |
| 2026-11-10 | Bind every agent to an accountable operator | Required for provenance, rate limiting, feedback independence, spending policy and legal accountability for earnings |
| 2026-11-10 | Keep contribution allow-listed until Phase 5 is accepted | Trust controls must exist before open submissions |
| 2026-11-10 | Replace cash royalties with non-cash contributor credits | **Superseded 2026-11-11** by the agent earnings and payout model below |
| 2026-11-11 | Replace non-cash contributor credits with a concrete agent-earnings, balance and payout model: economic attribution to the agent, legal accountability (legal/KYC/tax party, payout destinations, spending policy) with the one bound operator | Agents earn and spend autonomously within operator limits while a legally accountable party always exists; non-withdrawable credits would not test real incentives |
| 2026-11-11 | Search index is an external-content FTS5 table over an immutable per-version document table, with an explicit field allow-list built in TypeScript; Knowledge `explanation` is never indexed | Keeps untrusted prose out of discovery, avoids indexing platform data, and keeps earlier versions searchable and unchanged |
| 2026-11-11 | Internal search accepts bounded plain-text tokens only, combines them with implicit AND, searches latest versions only, applies typed shared and family-specific metadata filters, returns metadata only, and uses stable recency/ID ordering until ranking is separately implemented | Prevents FTS query syntax injection and paid-content leakage while keeping the first query service deterministic, predictable and independently testable |
| 2026-11-11 | Financial ledger is append-only, records `agentId` and `operatorId` on every entry, and derives `pending`/`available`/`reserved`/`spent`/`withdrawn`/`reversed` balances; credit redemption, credit expiry and the credit ledger are removed | Auditable, reconcilable, and prevents duplicate earnings and payouts |
| 2026-11-11 | Prefer provider-managed wallets or marketplace subaccounts over Agent Commons holding customer funds; provider not selected; KYC/AML, sanctions, tax, reconciliation and cross-border gates recorded | Reduces custody and money-transmission exposure; selection requires legal review |
| 2026-11-11 | Existing Phase 2 identity, provenance, contribution, versioning, hashing, D1 and R2 work remains compatible with the new model (`operatorId` is already immutable per agent and `ActorRef` carries both ids); no migrations, financial tables or payout code added | Avoids rework; financial schema is deferred to Phase 6 |
| 2026-11-10 | Earn on verified successful use, not on submission | Discourages low-quality and spam contributions |
| 2026-11-10 | Launch with one focused, owner-seeded content domain | Addresses supply-side cold start |
| 2026-11-10 | Support Knowledge and Execution as separate contribution schema families | Preserves agent-created knowledge beyond action recipes while retaining constrained, safer execution workflows |
| 2026-11-10 | Confine Knowledge prose to a capped, untrusted `explanation` field | Disguised instructions in prose cannot be reliably detected deterministically; structural limits reduce the injection surface |
| 2026-11-10 | Define Knowledge corroboration as deterministic checks | Keeps validation consistent with deterministic-first processing; consumer accuracy reports are weak evidence |
| 2026-11-10 | Apply a stricter earning test to Knowledge than Execution | Knowledge has no objective success check comparable to execution outcomes |
| 2026-11-10 | Set platform maximum review intervals per content type | Prevents contributors avoiding freshness decay with long intervals |
| 2026-11-10 | Envelope splits contributor-supplied from platform-only fields; agents carry a required immutable operatorId | Contributors cannot write reliability fields; enforces one operator per agent |
| 2026-11-10 | Link related contributions across families by reference, not mixing | Keeps each schema family clean while supporting recipes that depend on knowledge |
| 2026-11-10 | Price Knowledge and Execution separately | The two families face different competition and deliver different value |
| 2026-11-10 | Select API Integration and Troubleshooting as the first content domain | Supports sourced API knowledge and testable diagnostic/execution recipes, with low-cost controlled seeding |
| 2026-11-10 | Use Claude via pay-as-you-go Anthropic API for development only | Keep the production Agent Commons service LLM-free by default; store the key as a GitHub Actions secret, never in code |
| 2026-11-10 | Require manually approved Claude development runs and PR review | Control API expenditure, avoid unattended loops and keep development decisions traceable |
| 2026-11-11 | Cross-family references are `{family, id, version}` where `family` is the referenced (opposite) family; IDs match `^[a-z0-9][a-z0-9-]{7,63}$`; versions are positive safe integers and always explicit; duplicates, same-family refs and unknown fields are rejected; existence is checked via a caller-supplied (sync or async) resolver, with no storage dependency | Keeps families separate and references stable because stored versions are immutable. Rules in `docs/architecture.md` §8 |
| 2026-11-11 | Review-interval maxima are a code-defined, per-family allow-list of content types (knowledge: `api-limits` 30, `api-reference` 90, `error-reference` 180, `concept-summary` 365 days; execution: `api-recipe` 60, `diagnostic-recipe` 90 days); unknown content types are rejected; maxima are inclusive | Volatile content gets shorter intervals; contributors cannot override the platform maximum. Rationale in `docs/architecture.md` §8 |
| 2026-11-11 | D1 design: versions are append-only with a contiguous `previous_version` chain and immutability triggers; `UNIQUE(content_hash)` detects exact duplicates (hash of canonical validated input incl. family, excl. platform fields); references are composite FKs to the exact `(id, version, family)`; platform-computed fields sit in a separate mutable table; Knowledge facts/sources and Execution target domains are normalized, other family structures are JSON; review maxima stay in code; no hard deletes, all FKs `RESTRICT`. Rationale in `docs/d1-schema.md` | Makes one-operator-per-agent, immutability, duplicate detection and exact-version resolution database-enforced rather than convention |
| 2026-11-11 | Content hash = SHA-256 (Web Crypto) of canonical JSON (keys sorted by UTF-16 code unit, no whitespace, arrays in order, no Unicode normalization, `undefined` members omitted, non-finite numbers rejected) of the validated contribution including `family`, with `PLATFORM_ONLY_FIELDS` stripped; `hashContribution` validates first and never hashes invalid input | Matches `docs/d1-schema.md` §5 rule; identical content dedupes, family/order changes differ |
| 2026-11-11 | R2 convention: key `contributions/sha256/<hash of stored canonical-JSON bytes>` (= contribution `contentHash`), required `application/json` plus `family`/`contentType`/`sha256` metadata, write-once conditional puts, duplicates are no-ops, metadata conflicts rejected, reads re-verify hash. Binding lives only in local `wrangler.r2-local.jsonc` (placeholder bucket); tested with Miniflare via `getPlatformProxy` and a separate `tsconfig.r2-test.json` (workers + node types conflict on `URL` in the D1 config) | Immutability and dedup are enforced at the storage layer; deploy config untouched and no real bucket created |
| 2026-11-11 | Initial migration is `migrations/0001_initial_schema.sql`, taken verbatim from the reviewed design plus triggers on every immutable table; schema changes go in new numbered migrations. Local verification uses Node's built-in `node:sqlite` (loaded via `createRequire`, as Vite 5 cannot import it) for constraint tests and `wrangler d1 migrations apply --local` with a separate `wrangler.d1-local.jsonc` whose `database_id` is a placeholder, so the deployable `wrangler.jsonc` has no D1 binding. Adds dev-only `@types/node` | Constraints are tested without new runtime dependencies or any real/remote database; deploy config stays untouched |
| 2026-11-11 | Contribution creation writes R2 before D1: D1 never points to a missing object; a failed D1 batch leaves only a content-addressed orphan that is harmless, unreferenced and reused on retry (never deleted by the module). Duplicate hashes are rejected before any write (`UNIQUE(content_hash)` is the race backstop); the existing contribution id is disclosed only to the same operator. Contribution ids are platform-generated UUIDs; callers cannot supply ids, versions, hashes, contributors, timestamps or reliability fields | Preserves immutability and referential integrity across two stores without cross-store transactions, and avoids leaking other operators' content |
| 2026-11-11 | Versioning uses `expectedPreviousVersion` optimistic concurrency: a stale or future expected version returns `version_conflict` (with the latest version); a writer that loses a race inside the D1 batch fails on the `(contribution_id, version)` primary key, the batch rolls back, and it is also reported as `version_conflict`. Only the original operator may version a contribution (any of its active agents; the operator must stay allow-listed and active); a different operator gets `operator_mismatch`; family can never change; a duplicate hash of any version, including the contribution's own, is rejected | Keeps version chains contiguous and immutable without locks, and preserves the original operator's accountability |
| 2026-11-11 | Identity repository: platform assigns `op_`/`ag_` + 32-hex ids, timestamps, status and allow-list flag; callers pass only `kind`/`displayName`; only `displayName` is mutable and other fields raise `immutable_field`; suspension and revocation are one-way (no reactivation yet); suspended operators and revoked agents cannot register agents, edit profiles or act, but remain resolvable for provenance | Keeps accountability binding immutable and enforced in both service and schema triggers; reactivation and the allow-list setter need separate approval |
| 2026-11-11 | Agent credentials: opaque token `ac1_<24-hex public id>_<64-hex secret>` (32 random bytes); only a domain-separated SHA-256 digest is stored (no slow KDF or pepper: secret is high-entropy, no secret env exists yet); full token returned once; many credentials per agent for rotation, optional expiry, permanent one-way revocation, non-secret label; verification checks agent/operator status at request time and gives no distinction between unknown id and wrong secret | Safe rotation and revocation without storing recoverable secrets; HTTP auth, rate limiting and a keyed pepper remain separate approved tasks |
| 2026-11-11 | httpbin seed preparation: fixtures are typed data in `src/seed/httpbin.ts` with a pinned-commit source snapshot hashed with SHA-256; one explicit opt-in live check (`npm run seed:verify:httpbin`, never run by tests/CI) gates the Execution `owner-tested` label; Knowledge fixture is `source-checked`; both fixtures declare licence ISC (owner to confirm the contributed-content licence); nothing loaded into D1/R2 | Keeps seeding bounded and honest; loading needs a separate approved loader task and the seed checklist item stays open |
| 2026-11-11 | httpbin seed loading: the owner approved ISC as the contributed-content licence for both seed records; the Execution record is owner-tested only, never independently verified. `seedHttpbinContributions` is idempotent via a same-operator exact content-hash lookup (`findVersionByContentHash`, gated by the active allow-listed actor check) and verifies existing records through normal retrieval before reuse; Execution content embeds the exact stored Knowledge ID and version, so its hash is derived after Knowledge resolves | Safe reruns and partial-state resume without duplicate rows or R2 objects, no general search or API |
| 2026-11-11 | Baseline search ranking is a documented lexicographic SQL `ORDER BY` applied before `LIMIT`: freshness (current before stale; `reviewDueAt` = later of `asOf`/`lastVerifiedAt` + `reviewIntervalDays`, stale at `reviewDueAt` inclusive, injected reference time, exact integer milliseconds), family-aware evidence tier on a common 0–2 scale, `reliabilityScore` (null last), Knowledge corroboration (distinct source URIs beyond the first, cap 4; Execution 0), `created_at DESC`, `contribution_id ASC`. Every key is defined for both families so mixed-family order is total and transitive; no weighted score, no new columns or migration | Deterministic, explainable and testable with existing metadata only; keeps Phase 5 signals as later additions rather than claiming them |
| 2026-11-13 | `retrieval-response/v1` is a separate pure mapper over `RetrievedContribution`; Knowledge `explanation` is passed verbatim only as `untrustedExplanation` (`{label: "untrusted", text}` / `null`), never inside `content`; Execution has no such field | Structural separation lets consumers treat explanation as data; no retrieval, D1/R2 or error-code changes |
| 2026-11-13 | Retrieval results carry `related` built from the already integrity-checked D1 reference rows (same exact `{family, id, version}` type, stored order, deeply frozen) | Reuses the existing query and the D1/R2 equality check; no new D1 access or error codes |
| 2026-11-12 | Search results carry `related` (exact `{family, id, version}` references of the exact latest version, stored `ordinal` order) loaded by one bounded `json_each` bulk D1 query; discovery propagates it by allow-list; retrieval references remain a separate task | Avoids per-result queries and R2 access, keeps search metadata-only and ranking unchanged |
| 2026-11-10 | Execution validation is strict and allow-list based over a fixed four-step vocabulary (`http_request`, `extract_field`, `assert`, `wait`); no free-text fields: literals are whitespace-free tokens, steps may only address declared `targetDomains`, inputs and variables must be declared before use, writing methods require a non-read-only `sideEffect`, irreversible writes require human approval | Structural limits are the primary prompt-injection control; recipes are data, not permission grants. Headers/auth are deliberately excluded until credentials are designed |
| 2026-11-10 | Knowledge validation is strict and allow-list based: unknown fields, platform-only fields and Execution fields are rejected; scalar values are capped so prose cannot hide outside `explanation` | Structural limits are the primary prompt-injection control |

Record future decisions here when they materially change the architecture, scope, costs or development priorities.

---

## 9. Risks and Open Questions

| Risk or question | Required action |
|---|---|
| Unvalidated commercial value | Measure task cost with and without Commons content as soon as Phase 3 is functional |
| Agent adoption | Test real external agent discovery and usage |
| Content cold start | Seed API Integration and Troubleshooting with owner-tested Knowledge and Execution contributions in Phase 2 |
| Recipe decay | Track freshness and recent success; flag and down-rank stale content |
| Knowledge misinformation or source misuse | Validate provenance and rights; apply deterministic corroboration; never treat sourced text as trusted instructions |
| Prompt injection through Knowledge prose | Cap and separate explanation text, label it untrusted, and rank on structured facts |
| Copyright exposure from Knowledge summaries of third-party content | Treat as a distinct legal review item; restrict summary length and require source licensing evidence beyond self-declaration where feasible |
| Weak value of Knowledge against search engines and model knowledge | Price Knowledge separately; test whether corroborated, structured records save consumers measurable effort |
| Two-family scope roughly doubles validation, ranking and testing | If schedule slips, keep the shared envelope but take one family through Phases 5–6 first and record the decision |
| Execution schema overreach | Restrict action steps and targets without imposing execution-only fields on Knowledge |
| Content reliability | Define evidence required before verification |
| Malicious contributions | Constrain the schema; implement trust controls before open submissions |
| Feedback manipulation and fake identities | Restrict feedback to retrieving agents; weight by distinct operators |
| Copyright, site terms and data permissions | Establish contribution rules; require a licensing declaration |
| Personal data in snapshots (POPIA) | Scan for personal data; reject or quarantine affected contributions |
| Payment regulation | Obtain legal review of x402/stablecoin settlement (FSCA crypto-asset rules, SARB exchange control) before live payments |
| Custody, e-money and money-transmission classification | Prefer provider-managed wallets or marketplace subaccounts; obtain legal advice on whether agent balances are stored value before holding any funds |
| KYC/AML and sanctions | Require verified operators and screened payout destinations before any withdrawal |
| Tax reporting | Determine operator reporting obligations and data capture before live payouts |
| Cross-border payouts | Legal review (FSCA, SARB exchange control and destination jurisdictions) before enabling international payouts |
| Outstanding earnings liability | Cap balances (maximum autonomous balance), hold pending earnings, and reconcile ledger to provider records |
| Fraud, self-dealing and wash trading | Block self-purchases and same-operator earnings; settlement finality and refund holds; reverse earnings on refund or chargeback |
| Inter-agent transfers bypassing operator controls | Allow only operator-policy-permitted, ledgered transfers; refuse others |
| Duplicate earnings or payouts | Idempotency keys and uniqueness on (source purchase, beneficiary agent, entry type) |
| Compromised agent credential spending funds | Operator limits, minimum reserve, emergency suspension and withdrawal approval |
| Evaluate-before-buy paradox | Test whether discovery previews support purchase decisions without leaking content |
| Content retention after purchase | Define the licence granted per purchase; price accordingly |
| Operator spending authority | Provide spending limits and policies; test whether operators will authorize autonomous agent spending |
| Payment economics | Test whether purchase fees exceed processing costs |
| Contributor incentives | Validate that real earnings motivate quality contribution without encouraging spam or collusion |
| Search quality for agent queries | Test with realistic agent queries; Vectorize as a fallback |
| Token savings | Measure actual total task-completion costs |
| Platform competition | Demonstrate verified, fresh content as an advantage over free registries and repositories |
| Security | Review authorization, storage, payment and execution boundaries |

Do not expand scope solely to solve speculative future problems.

---

## 10. Next Development Actions

**Immediate task: Review and merge the PR for internal discovery-response UTF-8 byte budgeting.**

1. After it merges, choose the next bounded Phase 3 task (for example retrieval-response budgeting or retrieval caching/version checks); approve it separately and do not start it automatically.
2. Keep the next task internal and deterministic: no public HTTP/MCP APIs, Vectorize or LLM calls unless separately approved. Phase 5 ranking signals stay deferred until their data exists.
3. Do not create real D1 databases, apply remote migrations, create remote R2 buckets, seed remotely, or implement HTTP authentication or APIs until their tasks are approved. HTTP authentication and rate limiting belong to Phase 4; spending limits to Phase 6.

---

## 11. Project Update Procedure

After every completed development task:

1. Mark its checklist item complete.
2. Record the tests that verified completion.
3. Update the phase status and completion percentage.
4. Record any new blocker.
5. Add material architecture or scope decisions to the decision log.
6. Update the next development action.
7. Commit the code and documentation together.

### Session Handoff Summary

Maintain the following short record at the end of this document.

**Current phase:** Phase 3 In Progress  
**Last completed task:** Implemented internal discovery-response UTF-8 byte budgeting (`src/registry/discovery-budget.ts`: `budgetDiscoveryResponse` keeps the largest ranked prefix whose serialized JSON fits `maxUtf8Bytes`, exact `TextEncoder` measurement, a model-independent proxy for token cost and not an exact token count; no field/result truncation or reordering; typed errors; frozen budget metadata; `discovery-response/v1` unchanged; 9 tests; retrieval budgeting outstanding). Previously: Implemented the internal `retrieval-response/v1` mapper (`src/registry/retrieval-response.ts`: pure, discriminated Knowledge/Execution, explicit allow-list, deeply frozen independent copy of content; Knowledge `explanation` removed from `content` and exposed only as `untrustedExplanation` `{label: "untrusted", text}` or `null`; Execution has no explanation field; no `ContributionRetriever`, query, integrity or error-code changes; 12 tests). Previously: Added an immutable top-level `related` list (`{family, id, version}`, stored order, exact versions, deeply frozen, empty when none) to successful `RetrievedContribution`, built from the reference rows already loaded and verified against canonical R2 content (no new query, no error-code changes); 5 new tests in `test/registry/retrieval.test.ts` (both directions, empty, multiple/order, exact versions, immutability, D1/R2 mismatch rejection); `npm run verify` passed with 285 tests; retrieval-response redesign and explanation labelling remain. Previously: Added an immutable `related` list (`{family, id, version}`, exact latest version, stored order, deeply frozen, empty when none) to internal `SearchResultItem` via one bounded bulk D1 query (no R2) and propagated it through `discovery-response/v1` (13-key allow-list); new `test/registry/search-related.test.ts`; `npm run verify` passed with 280 tests; no ranking, retrieval, schema, migration or API changes; retrieval references remain. Previously: Implemented the internal family-labelled discovery-response contract (`src/registry/discovery.ts`: `buildDiscoveryResponse` maps ranked `SearchResultItem`s to `discovery-response/v1` with discriminated knowledge/execution items, 12-key allow-list, order preserved, deeply frozen; 8 tests; `npm run verify` passed with 273 tests; no D1/R2/routes/migrations). Previously: Implemented baseline deterministic, family-aware ranking and freshness handling for the internal `ContributionSearch` (D1 metadata only, SQL `ORDER BY` before `LIMIT`: current before stale, evidence tier per family on a common 0–2 scale, reliability null last, Knowledge corroboration capped at 4, `created_at DESC`, `contribution_id ASC`; results add `freshness` and `reviewDueAt`; reference time injected via `new ContributionSearch(env, { now })`); 11 new local D1 tests in `test/registry/search-ranking.test.ts` (both families, freshness boundaries, `lastVerifiedAt` anchor, stale demotion, null reliability, corroboration cap, deterministic ties, ranking before limits, latest-version-only) and existing search tests updated for ranked order; format, typecheck, lint, 265 passing tests, 8 R2 tests, Worker dry-run; no discovery responses, retrieval changes, APIs, Vectorize, LLM, feedback/trust, payments, migrations or remote resources. Previously: Implemented the internal D1 search-query service (`ContributionSearch`): bounded Unicode-aware plain-text tokenization with control-character rejection, implicit-AND FTS5 matching, latest-version-only results, typed shared filters (`family`, `contentType`) plus Knowledge (`verificationMethod`, `permittedUse`) and Execution (`verificationMethod`, `targetDomain`, `requiredCapability`, `sideEffect`, `requiresHumanApproval`) filters, stable recency/ID ordering, bounded limits and metadata-only results; tests cover httpbin queries, both families, filters, latest-only behavior, ordering, unsafe/empty input, Knowledge explanation exclusion and absence of R2/full-content access; format, registry typecheck, lint, tests and Worker bundle verified in CI; no ranking, discovery responses, full retrieval, APIs, R2 changes or remote resources. Previously: Implemented the internal D1 FTS5 search-index foundation: migration 0003 (`contribution_search_documents`, one immutable document per contribution ID + version with unindexed id/version/family/content type, composite FK to `contribution_versions`, insert-only; external-content FTS5 table `contribution_search` filled by trigger); deterministic `buildSearchText` (no LLM; fields listed in Phase 3; Knowledge `explanation` never indexed); document insert added to the existing atomic D1 batch for creation and versioning; new versions get their own document, earlier ones untouched; no backfill (repository-migrated databases only); 8 new local D1 tests (functioning FTS5, one document per family, term matches, explanation not findable, versioning immutability, failed creation leaves no registry/search rows, no-op migration reapply); format, typecheck, lint, 240 passing tests, 8 R2 tests, clean and no-op local migration, Worker dry-run; no search method, ranking, filters, discovery, HTTP/MCP, R2 changes, caching or remote resources. Previously: Loaded the prepared httpbin seed fixtures into the local registry (`seedHttpbinContributions`: existing active allow-listed agent only, no operator/agent/credential changes, Knowledge then Execution referencing the exact stored ID and version, idempotent by exact content hash and resumable from Knowledge-only; owner approved ISC as the contributed-content licence for both records; Execution is owner-tested only, not independently verified; no live httpbin request, `seed:verify:httpbin` stays opt-in); 3 new local D1/R2 tests; format, typecheck, lint, 232 passing tests, 8 R2 tests, clean local migration and Worker dry-run. Previously: Prepared (seed preparation only, nothing loaded into D1/R2, no loader) the owner-approved httpbin seed fixtures: Knowledge `api-reference` for `GET https://httpbin.org/get` (`src/seed/httpbin.ts`; ISC; cites httpbin docs and pinned source commit; checked-in snapshot `seed/httpbin/get-contract.snapshot.txt` with SHA-256 `fc86e985…beb4f`) and Execution `diagnostic-recipe` targeting only `httpbin.org` (extracts and asserts `args.agent_commons == seed-v1`; `executionWithKnowledgeRef` adds the Knowledge reference once a loader assigns ID/version); opt-in live check `npm run seed:verify:httpbin` (`src/seed/httpbin-live-check.ts`, `scripts/verify-httpbin-seed.ts`) run once at 2026-11-11T11:54:25Z: passed (HTTP 200, expected fields, `args.agent_commons=seed-v1`), so the Execution fixture is labelled owner-tested (not independently verified) and the Knowledge fixture is `source-checked`; 16 new offline tests (schema validity, snapshot hashing, deterministic content hashing, response checks); format, typecheck, lint, 229 passing tests, 8 R2 tests, clean local migration, Worker dry-run shows no bindings. Previously: Added the Phase 2 end-to-end identity and registry integration test (`test/registry/phase2-integration.test.ts`: operator and agent, credential issue/verify, allow-list gate and local admin enablement, Knowledge v1, Execution v1 referencing exact Knowledge ID/version, v2 of each, exact-version retrieval checked against identity, provenance, hashes, references, D1 rows and R2 bytes; duplicate content, unresolved references, stale expected version, revoked agent and suspended operator rejected with D1 unchanged), audited every Phase 2 acceptance criterion to test evidence, and reconciled the credential item (HTTP auth/rate limiting deferred to Phase 4, spending limits to Phase 6); no production code change; format, typecheck, lint, 213 passing tests, 8 R2 tests, clean and no-op local migrations, Worker dry-run shows no bindings. Previously: Implemented internal contribution retrieval by immutable contribution ID and exact version (`ContributionRegistry.getContributionVersion(contributionId, version)` in `src/registry/retrieval.ts`: loads identity, requested version, platform state, evidence, references and family rows from D1 and the canonical object from R2 by stored hash; verifies on every read object existence, byte hash and length, D1/R2 family, content-type and sha256 metadata, UTF-8 JSON parse, canonical form, family validator and agreement with D1 rows; returns a deeply frozen typed record of validated contributor input plus author, contributor, timestamps and platform state; code-and-generic-message errors distinguishing missing contribution, missing version, missing content, corrupted content and metadata inconsistency; 10 Miniflare D1+R2 tests; format, typecheck, lint, 212 passing tests, clean local migration apply, 8 R2 tests; no search, listing, latest alias, paid-access enforcement, HTTP APIs, authentication, remote resources, payments or earnings code). Previously: Replaced the non-cash contributor-credit model with the agent earnings, balance and payout architecture (documentation and identity comment only; verified by format, typecheck, lint and 202 passing tests; no migrations, tables, x402 or payout code). Previously: Implemented immutable contribution versioning (`ContributionRegistry.createContributionVersion(agentId, contributionId, expectedPreviousVersion, input)`: requires an active agent of the contribution's original operator, who must remain allow-listed; id and family permanent; next contiguous version with previous-version link, author agent, hash and timestamps; rejects stale/concurrent updates (`version_conflict`, race inside the batch caught via the primary key), missing contributions, family changes, other-operator authors, inactive actors, invalid content, unresolved references and duplicate hashes; validation, hashing, R2-then-one-D1-batch shared with creation; earlier versions and R2 objects untouched; 18 Miniflare D1+R2 tests; format, typecheck, lint, 202 passing tests, clean local migration apply, 8 R2 tests, Worker dry-run shows no bindings; no HTTP auth/APIs, search, deletion, remote resources or payments). Previously: Implemented initial contribution creation, version 1 only (`src/registry/creation.ts`: `ContributionRegistry.createContribution(agentId, input)` resolves the active agent and operator, requires the allow-list flag, rejects platform-only fields, runs the family validator, resolves references to exact stored versions, builds canonical JSON and SHA-256, rejects duplicate hashes before any write, assigns UUID id, version 1, contributor and timestamps; writes R2 first, then one atomic D1 batch for contribution, version, platform state, evidence, references and family rows; typed result with structured error codes; `wrangler.registry-local.jsonc` and `tsconfig.registry-test.json` local-only; 13 Miniflare D1+R2 tests covering Knowledge/Execution rows, immutable R2 content, duplicates, references, validation, platform fields, inactive actors, allow-list, D1-batch rollback with harmless R2 orphan and R2 failure writing no D1 rows; format, typecheck, lint, 184 passing tests, clean local migration apply, Worker dry-run shows no bindings; no versioning, HTTP auth/APIs, remote resources, search or payments). Previously: Implemented local D1 agent credentials (`migrations/0002_agent_credentials.sql`: `agent_credentials` table with public 24-hex id, SHA-256 digest only, label, optional expiry, one-way `revoked_at`, immutability/no-delete triggers, multiple per agent; `src/identity/credentials.ts`: `CredentialService` issues `ac1_<id>_<secret>` tokens from 32 random bytes via Web Crypto, returned once, digest domain-separated; verification rejects malformed/unknown/wrong-secret (indistinguishable)/expired/revoked tokens and revoked agents or suspended operators using constant-time digest comparison; idempotent revocation; parameterized queries; 13 Miniflare D1 tests incl. database plaintext absence and rotation overlap; migration test updated for the new table; format, typecheck, lint, 171 passing tests, clean local migration apply plus no-op re-apply, Worker dry-run shows no bindings; no HTTP auth, rate limiting, spending limits, contribution creation or remote resources). Previously: Implemented local D1 identity persistence and lifecycle (`src/identity/repository.ts`: `IdentityRepository` creates/gets operators, registers an agent under exactly one active operator, resolves agent to operator, updates only `displayName`, suspends operators and revokes agents one-way; platform assigns ids, timestamps, status and allow-list flag (preserved, default off); parameterized queries; structured `IdentityError` codes for invalid input, immutable fields, duplicates, not found, invalid transitions, suspended operators and revoked agents; 15 Miniflare D1 tests on the real migration; `tsconfig.identity-test.json`; format, typecheck, lint, 158 passing tests, clean local migration apply plus no-op re-apply, Worker dry-run shows no bindings; no credentials, auth, contribution creation, APIs or remote resources). Previously: Configured local-only R2 storage (`src/storage/content-objects.ts`: typed `CONTENT_BUCKET` binding in placeholder `wrangler.r2-local.jsonc`; key `contributions/sha256/<hash>`; required `application/json` type plus `family`/`contentType`/`sha256` metadata; conditional write-once puts, duplicate no-op, conflict rejection, hash re-verification on read; 8 new Miniflare tests via `npm run r2:verify:local`; `tsconfig.r2-test.json`; format, typecheck, lint, 143 passing tests, Worker dry-run shows no bindings; no remote bucket, D1 writes, creation/versioning, credentials or APIs). Previously: implemented deterministic content hashing (`src/registry/content-hash.ts`: `canonicalJson` with recursively sorted keys, no whitespace, array order preserved; `hashContribution` validates by family then hashes, `hashValidatedContribution` strips platform fields, family included; SHA-256 via Web Crypto, lowercase 64-char hex; 14 new tests; format, typecheck, lint, 135 passing tests, Worker dry-run; no persistence, D1/R2, API or versioning). Previously: implemented the initial D1 migration (`migrations/0001_initial_schema.sql`: all 12 designed tables, keys, FKs, uniqueness, indexes, RESTRICT deletion and immutability triggers; `wrangler.d1-local.jsonc` local-only placeholder binding and `npm run db:migrate:local`; `@types/node` dev dependency and `tsconfig.d1-test.json` for the Node SQLite test; 24 new tests covering one operator per agent, duplicate hashes, immutable versions, exact-version references, family isolation and platform state; format, typecheck, lint, 121 passing tests, clean local migration apply plus no-op re-apply, Worker dry-run; CI step proposed, not added). Previously: designed the D1 tables for identity and the content registry (`docs/d1-schema.md`: operators, agents, contributions, immutable versions, evidence, cross-family references, platform state, Knowledge and Execution extensions; keys, FKs, uniqueness, indexes, deletion/immutability rules, JSON vs normalized, TS mapping; design only, no migrations; DDL and constraints exercised in a throwaway in-memory SQLite check; format, typecheck, lint, tests, Worker dry-run). Previously: defined and implemented cross-family contribution references by ID and exact version (`src/registry/references.ts`: opposite-family `{family, id, version}` shape, ID/version format, duplicate and unknown-field rejection, storage-independent async-capable resolver; integrated into both validators; 32 new tests; format, typecheck, lint, 97 passing tests, Worker dry-run). Previously: defined and enforced platform maximum review intervals per content type (`src/registry/review-intervals.ts`, used by both validators; the unused `reviewIntervalMaxDaysCeiling` limits were removed; 29 new tests; format, typecheck, lint, 65 passing tests, Worker dry-run). Previously: defined and implemented the Execution contribution schema, fixed step vocabulary and deterministic validator (`src/registry/execution.ts`, shared primitives extracted to `src/registry/check.ts`; 18 new unit tests; format, typecheck, lint, 36 passing tests, Worker dry-run). Previously: defined and implemented the Knowledge contribution schema and deterministic validator (`src/registry/knowledge.ts`, 11 new unit tests; format, typecheck, lint, 18 passing tests, Worker dry-run). Previously: designed operator/agent identity model and shared contribution envelope with `family` discriminator (types plus 5 unit tests; format, typecheck, lint, 7 passing tests, Worker dry-run). Previously: upgraded to Wrangler 4.159.0 and Workers types v5; verified by clean install, formatting, typecheck, lint, 2 passing tests, Worker dry-run, local `/health` HTTP 200 smoke test and zero production dependency audit findings  
**Current task:** PR review and CI for discovery-response byte budgeting  
**Known blockers:** None; 16 development-only audit findings remain for separate Vitest and ESLint upgrade reviews  
**Next task:** After this PR merges (retrieval-response budgeting outstanding), a separately approved bounded Phase 3 task; HTTP authentication/rate limiting are Phase 4, spending limits Phase 6  
**Last verified commit:** `cd475d5` (`main` after PR #36) plus the `feat/discovery-response-budget` branch (targeted checks passed; full `npm run verify` result recorded in the PR)  

Update these fields at the end of each working session.

---

## 12. Definition of MVP Completion

Agent Commons MVP is complete when:

- [ ] External agents can discover the service.
- [ ] Every agent is bound to an accountable operator.
- [ ] Agents can submit both structured Knowledge contributions and declarative Execution contributions.
- [ ] Both families are validated under their own schemas and stored with shared provenance and versioning.
- [ ] Knowledge corroboration and family-specific earning tests operate deterministically.
- [ ] Agents can search available content, with freshness and reliability visible.
- [ ] Agents can retrieve sourced Knowledge records and compatible Execution recipes.
- [ ] Agents can report Knowledge accuracy/usefulness and Execution outcomes with evidence.
- [ ] Agents can purchase premium content using an authorized payment method or available earnings within operator-defined limits.
- [ ] Every agent financial account is bound to one accountable operator and every ledger entry records `agentId` and `operatorId`.
- [ ] Agent earnings from independent-operator purchases are recorded, finalized, and reconcile to successful purchases and provider records.
- [ ] Withdrawals go only to operator-approved, legally verified destinations.
- [ ] Legal and regulatory review of payments, earnings and payouts (KYC/AML, sanctions, tax, cross-border) is complete.
- [ ] Core functions have automated tests.
- [ ] End-to-end agent interactions have been demonstrated.
- [ ] Token consumption and operating costs are measurable.
- [ ] Security and trust controls have been reviewed.

**Final requirement:** Demonstrate that reuse of validated Knowledge or Execution contributions provides measurable economic value relative to agents independently researching or performing the task.

---

**Project instruction:** Build only what is required to achieve the next verified milestone. Preserve completed work, minimize repeated reasoning, and prioritize reliability over unnecessary complexity.

