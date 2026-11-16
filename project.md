# Agent Commons — Project Master Plan

**Project:** Agent Commons  
**Version:** 1.4  
**Status:** Phase 3 Complete
**Last updated:** 14 November 2026
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
- A bounded, authenticated way for agents to report unmet information or capabilities during the limited beta; these reports are product requests, not contribution feedback or verified evidence.
- Allow-listed contribution access until Phase 5 trust controls are accepted.

**Agent needs intake**
- An agent may report a missing capability, missing information, or an unsuccessful search, with a short desired outcome and optional related search terms.
- Store the reporting agent and accountable operator internally; do not accept caller-supplied identity, credentials, full prompts, logs, or private task data.
- Validate length and shape, scan for secrets and personal data, rate-limit and deduplicate reports, and let the operator review grouped requests by distinct operators.
- Requests are unverified product signals: they do not create contributions, public listings, trust scores, payments, or automatic development tasks. Define retention before enabling the endpoint.

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

Broader domains were originally to open only after the initial domain showed real reuse; the owner set that rule aside on 2026-11-16 (see Decision Log and the expansion below). Owner-tested does not mean independently verified; formal trust status follows Phase 5 controls.

### Domain Expansion: Software Troubleshooting

**Approved 2026-11-16; first 10 records listed the same day.** The pilot widens from API integration into software troubleshooting for developer tools and dependencies: exact error signatures, their causes and verified fixes, and breaking changes between versions. It deepens the selected domain rather than opening an unrelated one, and it targets what a consuming agent cannot know from training: behaviour that changed recently.

- **In scope:** command-line tools, package managers, runtimes, build tools and libraries that coding agents commonly drive; a second strand covers MCP clients, MCP servers and agent tooling (authentication quirks, limits, naming differences, known failure modes).
- **Out of scope for now:** website navigation, e-commerce, business administration and cloud deployment recipes (see Decision Log, 2026-11-16).
- **Mostly Knowledge.** The Execution step vocabulary is HTTP-only, so repair procedures that run local commands cannot be expressed as recipes. Execution stays limited to HTTP diagnostics until a vocabulary change is separately designed and approved.
- **Record convention (no schema change):** `contentType: "error-reference"` (Knowledge content types are a fixed list, so no new type is used); the title names the tool and the short error; facts use a small fixed set of predicates: `errorSignature` (the exact distinctive message text), `cause`, `affectedVersions`, `fixedInVersion`, `fix`, `workaround` and `observedOn` (tool version and platform). Each source is a changelog, release note, issue or source file pinned to a commit or release and hashed.
- **Evidence rule:** `owner-tested` only when the contributor reproduced the error and the fix; otherwise `source-checked` against the pinned source. Records without a pinned source are rejected at review. Review intervals stay short (30–90 days) because version-specific facts decay.
- **Known search constraint:** a query is at most 256 characters and 12 tokens, so a pasted stack trace is refused with `too_many_tokens`. Punctuation in error text is handled and fact values are indexed (checked on the pilot 2026-11-16).

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

**Status:** Completed

**Verified:** The Phase 3 acceptance audit below maps every criterion to tests and documentation; all eight current criteria are met. Search is deterministic and LLM-free: bounded plain-text tokenization, implicit-AND FTS matching, latest-version-only selection, typed shared and family-specific metadata filters and metadata-only results with derived `freshness` (`current`/`stale`) and `reviewDueAt`. Ranking uses persisted D1 metadata and is applied in SQL before the limit: current before stale; family-aware evidence tier; nullable reliability descending; Knowledge source corroboration; creation time; and contribution-ID tie-break. `reliabilityScore` is returned but currently null where no reliability data exists. The internal discovery mapper is family-discriminated, allow-listed and does not expose paid content. Discovery and retrieval responses include exact-version cross-family references. Complete verified retrieval, byte budgets and conditional `retrieval-not-modified/v1` responses are implemented and tested. Persistent shared caching and Phase 5 ranking signals are explicitly deferred and are not implemented.

**Indexed fields:** shared title, purpose, content type; Knowledge summary, fact subject/predicate/scalar value, record keys and scalar values; Execution objective, target domains, input/output names and types, required capabilities.  
**Deliberately excluded:** Knowledge `explanation`, fact units, sources, rights, evidence, licensing, verification claims, Execution steps, contributor/operator/agent ids, hashes, timestamps, platform state, raw JSON.

- [x] Implement D1 full-text search. (`test/registry/search-query.test.ts`; benchmarked against both families in `test/registry/search-quality.test.ts`.)
- [x] Implement metadata filtering, including `family` and family-specific fields. (`test/registry/search-query.test.ts`: family/content type and every Knowledge and Execution filter; `test/registry/search-quality.test.ts`.)
- [x] Implement baseline deterministic, family-aware ranking and freshness handling from persisted D1 metadata: freshness state and review-due time, stale demotion, evidence tier per family, null-safe reliability, Knowledge source corroboration (never explanation text), recency and contribution-ID tie-break, ranked before the limit. (`test/registry/search-ranking.test.ts`; repeated-result determinism also covered by `search-quality.test.ts`.)
- [ ] Extend ranking with Phase 5 signals: recent Execution outcomes, compatibility, source re-checks, feedback and validated reliability. *(Deferred to Phase 5, not a Phase 3 acceptance gap: the required outcomes, feedback and validated reliability data do not yet exist.)*
- [x] Create compact, family-labelled discovery responses that support evaluation before purchase without exposing the full paid contribution. (`src/registry/discovery.ts`, `discovery-response/v1`; `test/registry/discovery.test.ts` verifies both families, allow-listed fields and no paid-content fields. Internal mapper; no public route yet.)
- [x] Implement full Knowledge and Execution contribution retrieval, with Knowledge `explanation` text delimited and labelled as untrusted. *(`src/registry/retrieval-response.ts`: complete, family-discriminated, allow-listed and deeply frozen `retrieval-response/v1`; Knowledge `explanation` appears only as `untrustedExplanation`; Execution has no explanation field. `test/registry/retrieval.test.ts` verifies exact-version retrieval and D1/R2 integrity; 12 mapper tests in `test/registry/retrieval-response.test.ts`.)*
- [x] List cross-family references in discovery and retrieval responses. (`test/registry/search-related.test.ts` verifies search/discovery references; `test/registry/retrieval.test.ts` verifies exact-version references in both directions and D1/R2 agreement.)
- [x] Add token-budget controls. *(Discovery: `budgetDiscoveryResponse` in `src/registry/discovery-budget.ts` keeps the largest ranked prefix of `discovery-response/v1` that fits a positive safe-integer UTF-8 byte budget; typed `invalid_budget`/`budget_too_small` errors; frozen `{maxUtf8Bytes, usedUtf8Bytes, omittedResultCount}`; 9 tests in `test/registry/discovery-budget.test.ts`. Retrieval: `budgetRetrievalResponse` in `src/registry/retrieval-budget.ts` is all-or-nothing — the complete response is returned or typed `response_too_large`/`invalid_budget`; no field is truncated; 13 tests in `test/registry/retrieval-budget.test.ts`. `test/registry/response-size.test.ts` checks serialized sizes and budget boundaries. UTF-8 bytes of JSON output are a deterministic model-independent proxy for token cost, not an exact token count. Internal only; no public API.)*
- [x] Implement conditional retrieval/version checks and avoid retransmitting unchanged content when the exact contribution ID, version and content hash match. *(A matching validator returns minimal `retrieval-not-modified/v1`; otherwise the complete response is returned. `test/registry/retrieval-conditional.test.ts` and 11 Miniflare D1+R2 integration tests in `test/registry/retrieval-conditional-retriever.test.ts` verify matching/mismatching validators, both families, and that missing/corrupt/inconsistent D1/R2 state is never concealed. `test/registry/response-size.test.ts` verifies the not-modified response is constant-size and smaller than full responses.)*
- [ ] Implement shared persistent server-side retrieval caching. *(Deferred to Phase 6; not implemented and not a Phase 3 acceptance criterion. Authentication and entitlement boundaries do not yet exist. See the architecture decision below and the Phase 6 checklist.)*
- [x] Test search quality for Knowledge and Execution using realistic agent-generated queries. *(Unchanged 25-case benchmark: after PR #44, all 25 pass; top-1 22/22, top-3 22/22, 0 missed, 0 unexpected and 0 positive zero-result. `test/registry/search-quality.test.ts`, `test/registry/search-identifiers.test.ts`, `docs/search-quality.md`. Previously created local indexes must be recreated or reseeded; no remote D1 exists. Vectorize is not needed.)*
- [x] Test response size (`test/registry/response-size.test.ts`, `docs/response-sizes.md`; exact UTF-8 bytes, a proxy for token cost only).

**Acceptance criteria:**
- Agents can find relevant contributions from either schema family using natural task-oriented queries.
- Search results contain concise, actionable metadata, including freshness and reliability.
- Stale contributions are ranked down or flagged.
- Discovery responses allow a purchase decision without revealing purchasable content.
- Full contributions can be retrieved in their respective validated schemas.
- Repeated retrieval avoids unnecessary content transmission.
- Basic search and retrieval require no LLM calls.
- If keyword search fails quality testing, record the result and evaluate Vectorize before proceeding.

**Phase 3 acceptance audit (2026-11-14):** All eight current acceptance criteria are verified. Test suites run locally with Miniflare and real local migrations; the benchmark uses no network, remote resources or LLM.

| Acceptance criterion | Direct test and documentation evidence | Result |
|---|---|---|
| Find relevant contributions from either family with natural task-oriented queries | `test/registry/search-quality.test.ts` runs both-family benchmark cases; `docs/search-quality.md` records all 25 cases passing, top-1 22/22 and top-3 22/22. | Verified |
| Return concise actionable metadata, including freshness and reliability | `test/registry/search-query.test.ts`, `test/registry/search-ranking.test.ts` and `test/registry/discovery.test.ts` cover result metadata and discovery fields; nullable reliability is returned as `null` until reliability data exists. | Verified |
| Demote or flag stale contributions | `test/registry/search-ranking.test.ts` tests review-due boundaries and current-before-stale order; `test/registry/search-quality.test.ts` covers freshness ordering. | Verified |
| Enable purchase evaluation without revealing purchasable content | `test/registry/discovery.test.ts` verifies both families and rejects paid-content fields from the allow-listed response. | Verified |
| Retrieve complete contributions in their respective validated schemas | `test/registry/retrieval.test.ts` verifies Knowledge and Execution exact-version reads and integrity; `test/registry/retrieval-response.test.ts` verifies complete family-specific response mapping and untrusted Knowledge explanation handling. | Verified |
| Avoid retransmitting unchanged content on repeated conditional retrieval | `test/registry/retrieval-conditional.test.ts` and `test/registry/retrieval-conditional-retriever.test.ts` verify minimal matching responses, full responses on mismatch, and integrity errors taking precedence; `test/registry/response-size.test.ts` verifies the not-modified response is smaller. | Verified by conditional responses; no persistent cache |
| Basic search and retrieval require no LLM calls | `test/registry/search-quality.test.ts` explicitly runs local D1 search with no network, remote resources or LLM; `test/registry/retrieval.test.ts` exercises retrieval against local Miniflare D1/R2 only. The production LLM-free boundary is documented in `docs/architecture.md`. | Verified |
| Evaluate Vectorize if keyword search fails quality testing | `test/registry/search-quality.test.ts` and `docs/search-quality.md` report the unchanged benchmark at 25/25; `docs/search-quality.md` concludes Vectorize is not needed. | Verified; fallback not triggered |

**Milestone:** First functional Agent Commons content discovery and retrieval workflow.

---

### Phase 4 — Agent Interfaces

**Status:** Completed (2026-11-16). Every acceptance criterion below has live pilot or automated evidence; see `docs/api.md`, "Phase 4 acceptance traceability".

- [x] Implement REST endpoints. (Authenticated `POST /v1/commons/search`, `/get`, `/contribute` and `/feedback` use the shared Worker path.)
- [x] Implement local stdio MCP server for search/get/allow-listed contribute/feedback. (Official MCP TypeScript SDK v2; calls the existing Worker handlers and shares their validation, authentication, rate limiting, budgets and safe errors. Local D1/R2 only; credentials come from process configuration. In-memory MCP client integration tests and a stdio process smoke test pass.)
- [x] Add opt-in remote Streamable HTTP MCP at `/mcp` (PR #83, merged; enabled on the pilot and accepted by Claude Code for all four tools, including independent-operator feedback on 2026-11-16, PR #84). Shared tool definitions and existing Worker handlers serve search/get/contribute/feedback; every MCP request requires the enrolled agent credential and one D1 limiter charge. Explicit Host allow-list, browser Origin refusal, 1 MiB body bound, single-message POST and disabled-by-default `MCP_HTTP` gate. Focused SDK-client, stdio-server and pilot-preflight tests passed locally (37). Linux `npm run verify` passed on the PR branch: typechecks, formatting, lint, 920 tests across 56 files and Wrangler dry run. External-agent acceptance remains open; no remote enablement or deployment.
- [x] Add safe local-only MCP acceptance bootstrap. (Fixed local Wrangler config and persistence path; creates/reuses dedicated test identities, allow-lists the operator, and issues a fresh one-time credential through `CredentialService`. Focused bootstrap tests, typecheck, lint and formatting pass.)
- [x] Expose `commons.search`. (Authenticated `POST /v1/commons/search`, shared D1 rate limiting and discovery budgeting; PR #47 merged.)
- [x] Expose `commons.get`. (Authenticated exact-version `POST /v1/commons/get`, verified conditional retrieval, public response allow-list and all-or-nothing UTF-8 budgeting; PR #48 merged.)
- [x] Persist minimal Phase 4 exact-version retrieval receipts for feedback eligibility. (`migrations/0005_retrieval_receipts.sql`; `commons.get` records only authenticated agent, contribution ID and version after integrity verification and the full-response budget pass. Search, errors, budget failures and not-modified responses create none. Focused Worker, MCP and migration tests cover the boundary.)
- [x] Expose `commons.contribute` (allow-listed operators only). (Authenticated `POST /v1/commons/contribute` supports new Knowledge/Execution contributions and exact-next versioning through `ContributionRegistry`; focused local Worker tests pass. Phase 5 trust checks remain outstanding.)
- [x] Expose `commons.feedback` (agents that retrieved the content only). (Authenticated `POST /v1/commons/feedback` and MCP tool select Knowledge/Execution validation from the stored exact version, require that agent's Phase 4 receipt, reject the contributor operator, and persist unverified dimension reports. Same-agent revisions replace the active report; another same-operator agent cannot add the same dimension. No trust effects or revision history.)
- [x] Define structured error handling. (Versioned REST error envelope in `docs/api.md`; all four operations use the shared safe HTTP error mapper.)
- [x] Document integration examples for Knowledge lookup and Execution recipe retrieval. (Headless REST and local MCP setup/usage in `docs/api.md`; the Codespaces Copilot fixture-agent acceptance test passed for both families, with broader external-agent validation still open.)
- [x] Add agent needs intake after the pilot access gate: an authenticated, rate-limited REST operation for short missing-capability, missing-information, or failed-search reports; persist bounded reports for operator review, with deduplication, distinct-operator counts, scanning, and retention. Consider an MCP tool after the REST pilot proves useful. This is separate from contribution feedback. (Opt-in `POST /v1/commons/needs`, off unless `NEEDS_INTAKE=on` and independent of `PILOT_MODE`; accepts only category, summary, desired outcome and optional search terms; secret/personal-data and malicious-content scanning; per-operator deduplication and daily new-report limit; `migrations/0007_needs_reports.sql` with 90-day retention purged on intake and review; identity-free grouped review via `NeedsIntake.review()` / `npm run needs:review:local`. Covered by `test/worker-needs.test.ts` and `test/d1/migration.test.ts`. REST only; no MCP tool; not deployed.)
- [x] Add open wallet-based pilot enrollment (PR #80, merged). Headless ERC-4361 Sign-In with Ethereum, **EVM externally owned accounts only**; ERC-1271 smart-contract wallets need separate support. `POST /v1/enroll/challenge|complete|rotate`, off unless `ENROLLMENT=on` and fails closed (503) on incomplete configuration. Checks the exact message digest, domain, URI, chain ID, purpose, timestamps and one-time nonce, and consumes the nonce atomically. One wallet binds to one platform-assigned, allow-listed pilot operator and agent in one D1 transaction (migration 0011, immutable). The credential is returned once with `no-store`. A repeat or concurrent enrollment resolves to the same operator with no duplicate agent or credential. Wallet-signed rotation revokes the prior credentials and issues one new credential. Rate limits are per hashed IP, per address and global. Covered by `test/worker-enrollment.test.ts` (25) and `test/enrollment/siwe.test.ts` (6). Not enabled in any deployment.
- [x] Prepare a reviewable pilot deployment package (preparation only; nothing created or deployed). Dedicated `wrangler.pilot.template.jsonc` (DB and CONTENT_BUCKET bindings, no IDs/hostnames/secrets, policies unset, `PILOT_MODE=read-only`, enrollment/review/needs off), offline `npm run pilot:preflight` (placeholders, bindings, settings, policies vs local fixtures, secrets, migrations 0001–0011) with 19 tests, and the manual runbook, enablement, end-to-end test and pause steps in `docs/api.md`. Verified by `npm run verify` and a Wrangler dry run with throwaway config.
- [x] Test end-to-end interaction with an external agent for each family. (Authenticated Codespaces Copilot local-stdio MCP acceptance passed with the local allow-listed fixture agent for Knowledge and Execution: search, contribute and exact-version retrieval succeeded for both; test records are Knowledge `d78f4c99-ccaa-41d4-bc72-1bd08663eaa1` v1 and Execution `8e0a6088-26d9-4cb7-baf9-528acaeb388e` v1. The Execution recipe was not run. Broader external-agent validation remains open.)

**Acceptance criteria:**
- An external agent can discover and invoke Commons functionality.
- All four operations work through defined interfaces, with family-aware search, retrieval, contribution and feedback.
- Errors return actionable machine-readable information.
- The agent does not require a graphical interface.
- Requests are authenticated and rate-limited per agent and per operator.
- Contributions from non-allow-listed operators are refused.
- Feedback from agents that never retrieved the content is refused.
- A pilot agent can report an unmet need, and the operator can review grouped requests without treating request volume as proof of demand.

---

### Phase 5 — Content Validation and Trust

**Status:** In Progress; the bounded unverified feedback-intake slice is implemented. Phase-level acceptance remains incomplete.

- [x] Implement separate strict Knowledge and Execution JSON Schema validation. (Draft-07 schemas reject unsupported fields and preserve intentionally open Knowledge records and Execution value maps; existing family validators remain responsible for semantic and cross-field checks. Focused family schema tests pass.)
- [x] Implement duplicate detection. (Existing canonical SHA-256 content hashes, pre-write duplicate rejection and the D1 unique constraint are covered by content-hash, creation, versioning and migration tests; no duplicate-protection logic was rebuilt.)
- [x] Implement Execution target-domain allow/deny checks. (Platform-owned, required policy configuration enforces canonicalized exact-host/subdomain allow rules and boundary-matched denials, with denial precedence and no DNS lookups, for every declared target and HTTP request on contribution creation and versioning through REST and MCP. IANA special-use domains and IP literals remain rejected; contributors cannot override policy. Focused policy, creation/versioning, REST/MCP and immutable-read tests pass; `npm run verify` passes with 490 tests across 39 files and Wrangler dry-run.)
- [x] Implement Knowledge source/permission checks. (Every Knowledge source/evidence URI must be an absolute HTTPS URL with a valid public DNS hostname; embedded credentials, IP literals, malformed hosts, and the static IANA special-use registry and subdomains are rejected without DNS/HTTP requests. A required platform-owned policy matches exact `sourceLicense`/`permittedUse`/`dataPermission` combinations and requires `rights.sourceLicense` to match `licensing.license`; missing/invalid configuration and contributor overrides fail closed. Shared REST/MCP creation/versioning checks return field-level errors; immutable reads remain independent of mutable policy. Source ownership/truth, fetching, snapshots, and corroboration remain unverified and in their separate checklist item. Focused tests pass and `npm run verify` passes (590 tests across 40 files, Wrangler dry-run).)
- [x] Implement secret and personal-data scanning. (Deterministic, bounded pattern scanning of every string value, object key and positive integer in validated Knowledge and Execution content runs in the shared registry path before reference resolution, hashing or any D1/R2 write, so REST/MCP creation and versioning share one result. High-confidence detectors cover private keys, prefixed API tokens and JWTs, Bearer/Basic, credential query-parameter and URL-userinfo credentials, email addresses, `+` international and North American phone numbers, and Luhn-valid payment cards; reserved documentation domains, fictional 555 numbers, published test cards and placeholders are allowed. Errors are `invalid_content` with field path and category only; validation and JSON Schema errors no longer echo contributed field names or values. Limits fail closed. Detector limitations are documented in `docs/api.md`. Focused scanner, creation/versioning, REST and MCP tests pass, including no D1/R2 writes after rejection; `npm run verify` passes (643 tests across 41 files, Wrangler dry-run).)
- [x] Implement malicious-content checks for both structured Knowledge text/data and declarative Execution fields. (Deterministic, bounded, LLM-free checks of every string value and object key in validated Knowledge and Execution content run in the shared registry path after secret scanning and before reference resolution, hashing or any D1/R2 write, so REST/MCP creation and versioning share one result. Normalized phrase patterns reject clear agent-directed instruction overrides, chat-role/prompt delimiters, credential/private-data disclosure requests, tool use or action without authorization, and declared-target/approval-boundary bypass; bidi/tag control characters are rejected; Execution step and input URLs must stay within declared `targetDomains`. Directly negated wording and listed API-documentation phrasings pass. Errors are `invalid_content` with field path and category only, and flagged object keys are redacted. Knowledge explanation remains `untrustedExplanation`; the Execution step vocabulary is unchanged. Detection scope and limitations — not every prompt injection is caught — are documented in `docs/api.md`. Focused pattern, creation/versioning, REST and MCP tests pass, including benign examples and no D1/R2 writes after rejection; `npm run verify` passes (743 tests across 42 files, Wrangler dry-run).)
- [ ] Record contribution provenance.
- [x] Implement contribution quality states. (Storage foundation, PR #74, merged: migration 0008, trigger-assigned `pending` per exact version, typed read store, `test/d1/migration.test.ts`, `test/registry/quality-state.test.ts`. Private reviewer decisions, PR #75, merged: migration 0009 append-only history, platform-only `QualityReviewer`, `test/registry/quality-review.test.ts`. Consumer visibility gate, PR #76, merged: public search/get expose only `listed_unverified`, `test/worker-visibility.test.ts`. Contributor preview, PR #77, merged: authenticated `POST /v1/commons/preview` returns an exact `pending` version only to its authoring agent, uniform 404 otherwise, no receipt and no listing, `test/worker-preview.test.ts` for both families. Free-pilot cap (PR #78, merged): at most 100 distinct approved contribution IDs, enforced atomically in D1 by migration 0010 (see Decision Log); private `capacity_reached` result and private places used/remaining view, `test/registry/pilot-capacity.test.ts`, `test/d1/migration.test.ts`. Operator-only remote review (PR #79, merged): disabled-by-default `/v1/review/{queue,inspect,decide,capacity}` authenticated by a `REVIEWER_TOKEN` Worker secret with `REVIEWER_ID` from configuration, all decisions through `QualityReviewer`, headless `npm run review:remote`, `test/worker-review.test.ts`. Not included: enabling the interface in any deployment, token creation. Open wallet enrollment is tracked under Phase 4 (PR #80).)
- [ ] Implement family-specific freshness decay and re-verification flags.
- [ ] Implement deterministic Knowledge corroboration: source resolution checks, source hash/snapshot comparison and independent-operator agreement.
- [ ] Flag dependent contributions when a referenced contribution becomes stale or is withdrawn.
- [x] Implement independent feedback using the bounded Knowledge references and Execution structured summary in `docs/api.md`; reports remain unverified unless separately validated. (Authenticated, exact-version REST/MCP intake; family comes from stored content; one active report per consumer operator/version/dimension; no revision history or trust effects.)
- [ ] Weight feedback by distinct operators to limit self-rating and Sybil manipulation.
- [ ] Prevent unverified content from being represented as verified.
- [ ] Test malicious, malformed, misleading and stale submissions in both families.
- [ ] Test coordinated fake feedback from agents under one operator.

**Feedback implementation boundary:** The exact stored version selects the Knowledge or Execution schema; clients cannot choose it. Knowledge reports contain scoped accuracy, usefulness-in-context or staleness findings with bounded public HTTPS references. Execution reports contain only the bounded structured summary in `docs/api.md`; no execution is performed. Full schema validation is strict, including stored recipe identifiers and outcome consistency. The authenticated agent needs its Phase 4 exact-version receipt, and the contributor operator is ineligible. One active report is stored per consumer operator/version/dimension; the submitting agent can revise it in place, another same-operator agent cannot add a second report for that dimension, and other operators' conflicting reports remain separate. No revision history is retained. All reports remain unverified and do not change verification, freshness, reliability, ranking or earnings. See `docs/api.md` for the wire contract.

**Wire-level contract:** `docs/api.md` defines the validated Knowledge assessment fields and public-reference constraints, plus the Execution structured summary with exact step/capability/version cross-references and status enums. The stored version family selects the schema; clients cannot choose it. The Phase 4 exact-version receipt remains the eligibility gate. Execution summaries are agent-supplied and unverified, not platform test results.

**Remaining separate decisions:** whether and how to build a trusted runner to validate Execution summaries; storage retention; aggregation thresholds; and trust/reliability/ranking effects. Different operators' conflicting reports remain separate; retries and in-place revisions create no history.

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
- [ ] Implement shared persistent server-side content caching only after Phase 4 authentication and Phase 6 paid-access/entitlement semantics exist. Cache keys must include immutable contribution ID, version and content hash plus an appropriate authorization scope; cache hits must not conceal D1/R2 integrity failures or treat mutable platform state as immutable content.
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
| 3. Search and Retrieval | Completed | 100% |
| 4. Agent Interfaces | Completed | 100% |
| 5. Validation and Trust | In Progress | 0% |
| 6. Payments, Agent Earnings and Payouts | Not Started | 0% |

**Current phase:** Phase 4 completed on 2026-11-16 (remote MCP for all four tools, independent-operator feedback and remote needs intake with grouped review verified on the pilot); Phase 5 In Progress. The opt-in remote MCP route (PR #83, merged) is enabled on the pilot (owner-reported) and passed external-client acceptance with Claude Code except independent-operator feedback (PR #84); authenticated REST `commons.search`, exact-version `commons.get`, allow-list-enforced `commons.contribute`, and authenticated `commons.feedback` use shared Worker validation, credential verification and D1 rate limiting; local stdio MCP exposes all four operations through that path. The local MCP acceptance bootstrap uses only the fixed local Wrangler config and persistence path and provisions a dedicated allow-listed test fixture. The authenticated Codespaces Copilot MCP acceptance test passed search, contribute and exact-version retrieval for both Knowledge and Execution; corresponding test records were created, and the Execution recipe was not run. The minimal Phase 4 receipt is implemented for complete, integrity-verified, budget-passing full responses only. Feedback requires that exact receipt, validates against the stored family and persists unverified reports; it does not change trust or reliability. Focused Worker and MCP tests verify feedback; broader external-agent validation and Phase 4 completion remain outstanding. Phase 5 has separate strict contribution JSON Schemas, covered by focused family tests. Execution target validation rejects every name in the static IANA Special-Use Domain Names registry snapshot and its dot-boundary subdomains, without DNS lookups; its platform-owned allow/deny policy is enforced on contribution creation and versioning through REST/MCP, while immutable-version integrity checks remain independent of mutable policy. Knowledge source/evidence URLs are validated as public HTTPS references without network requests, and a required platform-owned policy accepts only explicit declared permission combinations on Knowledge writes; immutable reads do not consult mutable policy. These checks do not establish claim ownership or truth; source fetching, snapshot comparison and corroboration remain open. Secret and personal-data scanning rejects high-confidence secrets and personal data in both families before any D1/R2 write on REST/MCP creation and versioning, with value-free error messages; it is a pattern-based safety net, not proof of absence. Deterministic malicious-content checks likewise reject clear agent-directed override, disclosure, unauthorized tool-use and boundary-bypass phrases, prompt delimiters, hidden bidi/tag characters and undeclared Execution URLs in both families before any write; they are a safety net for clear attempts and do not catch every prompt injection. Opt-in agent needs intake (`NEEDS_INTAKE=on`, off by default) accepts bounded, scanned, per-operator-deduplicated reports for identity-free grouped operator review with 90-day retention; it is REST-only and locally verified. Phase 5 quality-state storage foundation (PR #74, merged) adds a `pending`-by-default state per version. Private platform-only reviewer decisions (PR #75, merged) allow `pending`→`listed_unverified`/`rejected` and `listed_unverified`→`withdrawn` with an append-only history; approval means only "allowed to list as unverified" and sets no verification or reliability field. Consumer visibility gate (PR #76, merged): public search returns only `listed_unverified` versions (newest listed version per contribution) and `commons.get` returns a uniform `404 not_found` for any other state, before content, validator comparison or receipt; related references and `previousVersion` to non-listed versions are omitted and responses are labelled `listed_unverified` (not independently verified). Contributor preview (PR #77, merged): authenticated `POST /v1/commons/preview` lets an agent read only an exact `pending` version it authored (identity from credential, ownership and state checked before content; all other cases a uniform 404; labelled `pending`; no receipt, never searchable). The free-pilot cap of 100 distinct approved contribution IDs (PR #78, merged) is enforced in D1 at the `pending`→`listed_unverified` decision. An operator-only, disabled-by-default remote review interface (PR #79, merged) exposes the pending queue, exact-version inspection, decisions and capacity to a reviewer-token holder only, through `QualityReviewer`. Open wallet-based pilot enrollment (PR #80, merged) is off by default. It lets any EVM externally owned account obtain one platform-assigned operator, agent and credential through a signed ERC-4361 challenge, with explicit wallet-signed credential rotation. Smart-contract wallets (ERC-1271) and non-EVM wallets are not supported. Enrolled contributions remain `pending` and invisible until operator review. `npm run verify` passes (882 tests across 52 files and Wrangler dry-run). Exact duplicate-content protection was already implemented and verified through canonical hashing, pre-write checks and the D1 uniqueness constraint. The remaining Phase 5 controls are outstanding. Phase 3 Search and Retrieval is complete at 100%; persistent caching remains deferred to Phase 6. Phase 2 is complete.
**Current blocker:** None for remote MCP: all four tools, including feedback from an independent second enrolled operator, are accepted by an external client (Claude Code, 2026-11-16; see `docs/api.md`, "Completed remote MCP acceptance test (Claude Code)"). Remote grouped needs review is implemented (PR #86), but `NEEDS_INTAKE` is not yet enabled on the pilot, so the needs acceptance criterion is not yet verified live. Execution contribution through remote MCP remains untested. ERC-1271 smart-contract wallets and non-EVM wallets are unsupported.
**Earlier verified milestone (PR #81):** Pilot deployment package (preparation only): `wrangler.pilot.template.jsonc` (git-ignored local copy holds real IDs; policies are placeholders, enrollment, review and needs intake off, `PILOT_MODE=read-only`), offline `npm run pilot:preflight` (`src/pilot/preflight.ts`, 19 tests in `test/pilot/preflight.test.ts`), and the manual create/migrate/secret/deploy/verify, enablement, end-to-end test and pause runbook in `docs/api.md` ("Pilot deployment package"). A Wrangler dry run with non-secret throwaway config passed. The 100-place cap counts approved contribution IDs, not wallets. **Subsequent owner-reported deployment:** remote D1/R2, migrations, reviewer secret and Worker now exist; see the current deployment status below. Earlier: Open wallet-based pilot enrollment (PR #80, merged). `src/enrollment/` serves `POST /v1/enroll/challenge|complete|rotate` only when `ENROLLMENT=on` with a valid `ENROLLMENT_DOMAIN`, `ENROLLMENT_URI` and `ENROLLMENT_CHAIN_ID`; otherwise it returns 403 (off) or 503 (invalid), before storage access. Server-generated ERC-4361 messages are verified as EIP-191 `personal_sign` signatures from EOAs, via the audited `@noble/curves` and `@noble/hashes` libraries. The exact message digest, domain, URI, chain, purpose, timestamps and one-time nonce are checked, and the nonce is consumed by one conditional UPDATE. Migration 0011 adds `wallet_challenges` and the immutable `wallet_accounts` binding. First enrollment creates an allow-listed operator, agent, binding and credential in one D1 transaction. Repeat and concurrent enrollments resolve to the same operator without new agents or credentials. Rotation revokes the prior credentials and issues one new credential. Requests are rate-limited per hashed IP, per address and globally. No identity IDs are accepted. Credentials are returned once with `no-store`. Documented in `docs/api.md`; nothing deployed. `npm run verify` passes (882 tests across 52 files, Wrangler dry-run). Earlier: Operator-only remote review (PR #79, merged): `src/review/routes.ts` serves `POST /v1/review/queue|inspect|decide|capacity` only when `REVIEW_INTERFACE=on`, with a validated high-entropy `REVIEWER_TOKEN` secret and `REVIEWER_ID`; invalid configuration returns 503, and the constant-time token check runs before any D1/R2 access (401 otherwise; agent credentials never accepted, reviewer token not an agent credential). Decisions (`approve`/`reject`/`withdraw` with required reason) go through `QualityReviewer.decide`, so D1 transition and capacity triggers stay authoritative; new `QualityReviewer.pendingQueue` keyset pagination; inspected content returned under `untrusted`; headless `npm run review:remote` reads the URL and token from the environment and never prints the token; setup documented in `docs/api.md`; no migration, nothing deployed, no token created; `npm run verify` passes (851 tests across 50 files, Wrangler dry-run). Earlier: Free-pilot capacity cap (PR #78, merged): migration 0010 `pilot_capacity_places` + triggers (first approval of an ID claims a place; later versions, rejection use none; withdrawal frees none; pre-existing approvals backfilled; atomic in the decision batch; at capacity `capacity_reached` with no state change or history row); private `QualityReviewer.capacity()` and `npm run versions:review:local -- capacity`; no public exposure, nothing deployed; `npm run verify` passes (830 tests across 49 files, Wrangler dry-run). Earlier: Contributor preview (PR #77, merged): `POST /v1/commons/preview` (REST only) for an agent's own exact `pending` version; `test/worker-preview.test.ts` (14 tests, both families); `commons.get` gate unchanged; no migration, nothing deployed; `npm run verify` passes (821 tests across 48 files, Wrangler dry-run). Earlier: Consumer visibility gate (PR #76, merged): shared Worker gate for search and get (REST and local MCP) limiting public responses to `listed_unverified`; `ContributionSearch` gains an explicit `visibility` option (default `all` for private/internal use); 10 new tests in `test/worker-visibility.test.ts` and existing Worker/MCP fixtures now listed; `npm run verify` passes (807 tests across 47 files, Wrangler dry-run). No migration, nothing deployed. Earlier: Private reviewer decisions (PR #75, merged to `main`): migration 0009 (append-only `version_quality_decisions`; triggers reject decisions that do not match the current state and state changes without a matching decision), platform-only `QualityReviewer` (`src/registry/quality-review.ts`; inspect through the integrity-checked D1/R2 retrieval path; history and state change in one D1 batch; content re-verified before approving or rejecting) and local `npm run versions:review:local` (reviewer id from `COMMONS_REVIEWER_ID`); 12 new tests; `npm run verify` passes (797 tests across 46 files, Wrangler dry-run). No REST/MCP exposure, no visibility change. Earlier: Quality-state storage foundation (PR #74, merged to `main`): migration 0008, trigger-assigned initial `pending` state, `pending` backfill of existing versions and a typed read store; 6 new tests; `npm run verify` passes (785 tests across 45 files, Wrangler dry-run). Not a publication gate. Earlier: opt-in agent needs intake, PR #73, merged to `main`. Opt-in agent needs intake: authenticated, rate-limited `POST /v1/commons/needs` (off unless `NEEDS_INTAKE=on`; invalid values fail closed with 503; usable in read-only pilot mode while contribute/feedback stay disabled) with strict four-field validation, secret/personal-data and malicious-content scanning, per-operator deduplication, a per-operator 24-hour new-report limit (default 20), D1 storage with 90-day retention and purge, and identity-free grouped review counting distinct operators. 32 new tests; `npm run verify` passes (779 tests across 44 files, Wrangler dry-run). Nothing deployed; no remote resources created; no GitHub issues or tasks are created from reports. PR #72 (read-only pilot mode) was merged to `main` as `9ddd5b1`. Earlier: an explicit `PILOT_MODE=read-only` Worker setting (unset/`off` keeps current behavior; invalid values fail closed with 503) disables `commons.contribute` and `commons.feedback` before their handlers run while search, get and the minimal retrieval receipt remain available; covered by `test/worker-pilot-mode.test.ts` and documented in `docs/api.md`. `npm run verify` passes (747 tests across 43 files, Wrangler dry-run); nothing was deployed and no remote resources were created. Earlier: PR #70 added deterministic malicious-content checks for Knowledge and Execution contributions to the shared REST/MCP creation and versioning path, before any D1/R2 write, with value-free errors. `npm run verify` passes: typecheck, formatting, lint, 743 tests across 42 files and Wrangler dry-run. PR #70 was merged; no deployment was performed. PR #68 (secret and personal-data scanning) was merged to `main` as `cd6bab0`. Phase percentages remain unchanged.

**Deployment status update (owner-reported, 2026-11-15):** The pilot Worker is live with D1/R2 and migrations 0001–0011. MetaMask EOA enrollment issued a credential. The owner submitted, reviewed, searched and retrieved one Knowledge and one linked Execution contribution through REST; capacity returned 2 used / 98 remaining. These operational reports were not independently repeated in this development task.

**Remote MCP status update (2026-11-16):** The owner reports deploying merged PR #83 to the pilot with `MCP_HTTP=on` and the Worker hostname in `MCP_ALLOWED_HOSTNAMES`, and owner-run MCP `initialize`, `tools/list`, `commons.search` and `commons.get` checks passed with the enrolled agent credential. Claude Code (desktop, Windows) then connected as an external MCP client with the credential from a user environment variable: search, both-family get, Knowledge contribute, pending invisibility, owner review via `npm run review:remote`, and listed visibility passed. Test record: Knowledge `5056d082-3fcf-409e-866a-793b834d6bd7` v1; capacity 3 used / 97 remaining. Feedback was refused as designed (same contributor operator). Client findings: Claude Code renames tools to `commons_search` etc.; the `commons.contribute` description omits the required Knowledge source `hash`; the live httpbin `/get` response now includes `method`, absent from the seed record.

Completion percentages must reflect verified acceptance criteria, not merely generated code.

---

## 8. Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-16 | Expand the pilot's content domain into software troubleshooting (error signatures, causes, verified fixes and breaking changes for developer tools, dependencies and agent tooling), ahead of evidence of reuse in the initial domain. Website navigation, e-commerce, business administration and cloud deployment recipes stay out of scope | Owner decision. The reachable agents are mostly coding agents; keyword search suits exact error text; recent changes are what consuming agents cannot know from training; the fit with one reviewer and the remaining approval places is good. The owner has set aside the earlier rule that broader domains open only after the initial domain shows real reuse: the pilot should be live, useful and widening while it is built, and learn from use rather than wait for evidence. Usage numbers inform what to add next; they are not a gate |
| 2026-11-16 | List the pilot publicly in the official MCP Registry as `io.github.lankylo/agent-commons`, with no cap on wallet sign-ups | The owner wants open discovery by outside agents. Exposure is bounded by operator review of every version, the 100 approved-ID cap, rate limits and content scanning; `ENROLLMENT=off` or the pause procedure stops new sign-ups if review load or abuse grows. Enrollment itself is not capped |
| 2026-11-16 | "MVP live" first means the free, operator-reviewed, 100-place-capped pilot open to outside agents (Section 10, "Pilot launch milestone"). Payments, earnings and payouts (Phase 6) are excluded from this milestone and remain required for the full MVP in Section 12 | Lets outside agents use and test reuse value now; Phase 6 is gated on legal review and provider selection, which are not code work |
| 2026-11-16 | Keep every Commons operation, including search and get, authenticated by an enrolled agent credential; do not open anonymous reads. Reduce friction on the agent side instead: headless wallet enrollment for agents with their own wallets, agent-readable onboarding, and actionable unauthenticated responses. A wallet address alone is never an identity; it may later serve only as a verified payout destination. Phase 6 paid retrieval should accept x402 payment authorization so paying needs no separate account step | Anonymous reads would let the corpus be scraped, removing its value. Signed enrollment keeps one accountable operator per agent for rate limits, feedback eligibility and future earnings; an unsigned address proves nothing |
| 2026-11-15 | Serve remote MCP only behind `MCP_HTTP=on` and an exact hostname allow-list; authenticate and charge each protocol request once, then dispatch tool calls to existing REST handlers without a second charge. Refuse browser Origin requests, bound POST bodies, and keep requests isolated | Enables external agent hosts after separate deployment while preserving credential, visibility, policy and pilot gates; no session or unauthenticated discovery surface. |
| 2026-11-15 | Serve wallet enrollment as a minimal same-origin page at `/pilot/enroll` only when `ENROLLMENT=on`; obtain the selected EVM account, request and display the existing server challenge, recheck its configured chain before `personal_sign`, and submit the exact message/signature to the existing complete route. Show the issued credential once with explicit copy/save controls; keep rotation headless | Reuses the existing REST verification and one-time issuance without a second enrollment implementation, a third-party signer, or browser credential persistence; restrictive CSP and no-store headers limit exposure. Live MetaMask acceptance remains a separate validation |
| 2026-11-15 | Open pilot enrollment uses wallet sign-in, not GitHub OAuth. ERC-4361 messages are generated by the server and verified as EIP-191 `personal_sign` from **EVM externally owned accounts only**. Each wallet address binds permanently to one platform-assigned operator and agent; repeat enrollment never issues a credential; rotation is an explicit wallet-signed operation. Off by default (`ENROLLMENT=on` plus exact domain, URI and chain ID; otherwise fail closed). Verification uses `@noble/curves` and `@noble/hashes` | Open, vendor-neutral, headless onboarding without collecting GitHub identity, payment or KYC data and without on-chain transactions. Wallet sign-in is identity only, not custody or payments. Smart-contract wallets need ERC-1271 on-chain verification, deferred. Sybil resistance is limited to rate limits, review and the 100-place approval cap |
| 2026-11-15 | Contributor preview is a separate REST operation (`POST /v1/commons/preview`), not a `commons.get` mode: it serves only an exact `pending` version authored by the authenticated agent, checked in one query before any content read; every other case shares the uniform 404 | Keeps the consumer gate unchanged and avoids leaking existence to other agents/operators; preview writes no receipt, so it grants no feedback eligibility and never makes content searchable. Remote reviewer access is deferred as a deployment blocker |
| 2026-11-15 | Free pilot is capped at 100 distinct approved contribution IDs, enforced when a reviewer moves a version `pending`→`listed_unverified`. The first approval of an ID uses one place; later versions of that ID use none; rejection uses none; withdrawal never frees a place; approvals predating migration 0010 are counted. Enforced by D1 triggers in the same batch as the decision, so concurrent reviewers cannot exceed 100; at capacity the reviewer gets `capacity_reached` and nothing is recorded. Places used/remaining are visible only through the private reviewer path | Bounds pilot exposure and review load without public signup or automatic approval; atomic database enforcement avoids races. Cap is a pilot rule, not a trust signal; no public endpoint exposes counts or other contributors |
| 2026-11-15 | Remote pilot review is a separate operator-only prefix `/v1/review/*`, disabled unless `REVIEW_INTERFACE=on`, authenticated by a single high-entropy `REVIEWER_TOKEN` Worker secret (constant-time, before any storage access) with the reviewer identity from `REVIEWER_ID` configuration; invalid configuration fails closed (503). It never accepts agent credentials, has no MCP tool and routes every decision through `QualityReviewer` | Lets the operator review a deployed pilot headlessly without exposing queue, history, capacity or pending content to agents or the public, and without bypassing D1 transition/capacity enforcement. A shared-secret bearer token is adequate for a single pilot reviewer; per-reviewer identities or SSO are deferred |
| 2026-11-15 | Consumer visibility gate: public search/get expose only `listed_unverified`; searched version is the newest listed version; every non-listed or unknown version gives one uniform 404 before content, validator or receipt; related references and `previousVersion` to non-listed versions are omitted; responses carry a `quality` label stating `independentlyVerified: false` | Prevents pending/rejected/withdrawn content and its existence from leaking while listing means only "allowed to list". The gate is in the shared Worker handler so REST and MCP agree; the private reviewer path is unchanged |
| 2026-11-15 | Limited beta starts as read-only pilot mode: `PILOT_MODE=read-only` permits authenticated search/get (with retrieval receipt) and rejects contribute/feedback with 403 before handlers run; unset/`off` is the local default and invalid values return 503 on all commons routes | Allows controlled external agent use without open submissions, payments or trust effects; the explicit allow-list setting fails closed. Not enabled in committed deploy config; phases 4 and 5 remain incomplete |
| 2026-11-15 | Agent needs intake is a separate opt-in setting (`NEEDS_INTAKE=on`; unset/`off` returns 403; invalid fails closed with 503), REST-only, with 90-day retention after the last equivalent report, per-operator deduplication by normalized fingerprint and a default limit of 20 new reports per operator per trailing 24 hours | Keeps the only pilot submission path explicitly enabled and bounded; retention and limits are defined before any enablement; review output omits identities and treats counts as unverified signals |
| 2026-11-15 | Capture authenticated agent reports of unmet information, missing capabilities, and unsuccessful searches as bounded product feedback after the pilot access gate; group by distinct operators and require operator review before prioritizing work | Reveals what agents cannot accomplish with Commons while limiting spam and avoiding automatic roadmap changes or confusion with contribution-quality feedback |
| 2026-11-15 | Malicious-content checks are deterministic normalized phrase patterns (agent-directed imperatives, direct-negation exemption) over every string and key in both families, plus a structural rule that URLs in Execution `steps`/`inputs` must use declared `targetDomains`; they run after secret scanning and before any write, return path/category-only errors, and add no quality state or quarantine | Rejects clear injection attempts without an LLM, execution or fetching, while keeping structural limits (untrusted explanation label, fixed step vocabulary) as the primary control; limitations are documented rather than claiming complete detection |
| 2026-11-14 | Execution HTTP targets must be declared DNS hostnames; compare canonical lowercase hostnames without a trailing dot, allow only exact declared hosts or subdomains separated by a hostname boundary, and reject local/reserved names and IP literals | Prevents undeclared-host and suffix-lookalike targets without DNS resolution, URL fetching or recipe execution |
| 2026-11-14 | Provide a no-argument bootstrap for MCP acceptance testing that is pinned to `wrangler.registry-local.jsonc` and `.wrangler/mcp-local`, creates/reuses only dedicated test identities, and prints each newly issued credential once | External-agent setup needs a local active credential and contribution allow-list entry without permitting remote configuration, persisting plaintext secrets, or reprinting an unrecoverable credential. |
| 2026-11-14 | Public `commons.get` responses omit the internal `author` and `contributor` agent/operator identities; Knowledge explanation remains a separately labelled `untrustedExplanation`, and related references retain exact family/ID/version only | The public API exposes only fields needed to identify, evaluate and reuse a contribution, without disclosing internal identity links or weakening the untrusted-content boundary. |
| 2026-11-14 | Expose search/get/allow-listed contribute through an official-SDK local stdio MCP adapter that invokes the existing Worker handlers; read the agent credential only from process configuration | One implementation of request validation, authentication, shared D1 limits, response budgets, allow-listing and safe errors avoids REST/MCP drift. Stdio keeps the adapter local-only without a Worker route or remote MCP service. |
| 2026-11-14 | Assign only the minimal exact-version retrieval receipt needed for feedback eligibility to Phase 4; reserve assessment schemas and trust effects for Phase 5 | Phase 4's feedback-eligibility criterion requires evidence tied to the authenticated agent and exact version. `commons.get` persists only agent ID, contribution ID and version after integrity verification and the response budget, immediately before success; searches, errors, budget failures and not-modified responses do not qualify. |
| 2026-11-14 | Keep consumer feedback as unverified evidence; select schema from stored family and exclude the contributor operator | Knowledge uses bounded public HTTPS pointers; Execution uses a bounded structured summary, not arbitrary logs or URLs. A Phase 4 receipt gates exact-version eligibility. One active report per consumer operator/version/dimension is retained; the submitting agent can revise it in place, another same-operator agent cannot add the same dimension, and other operators' conflicting reports remain separate. No revision history or trust effect is stored. |
| 2026-11-14 | Implement authenticated REST/MCP feedback intake with strict stored-family validation and one active report per operator/version/dimension | A single current row supports idempotent retries and same-agent revision without a history log. Same-contributor operators are ineligible; a second agent under a consumer operator cannot add the same dimension. Cross-operator conflicts stay separate. Reports remain unverified and do not alter platform trust or ranking. |
| 2026-11-15 | Validate Execution targets against an explicit static snapshot of the IANA Special-Use Domain Names registry, including dot-boundary subdomains, without DNS lookups | Deterministic hostname checks avoid resolver-dependent policy and reject all registered special-use names while preserving ordinary public hosts such as `httpbin.org`; the snapshot is updated deliberately. |
| 2026-11-15 | Enforce a required, platform-owned Execution domain allow/deny policy only when creating a contribution or version | Exact-host and explicit subdomain allowances, boundary-matched denials and deny precedence are applied through the shared REST/MCP write path. Mutable policy is excluded from immutable-version integrity validation; later policy changes require a separate quality-state decision for existing contributions. Local test rules stay out of deployable configuration. |
| 2026-11-15 | Scan both contribution families for high-confidence secrets and personal data on creation and versioning only, and keep all contribution error messages value-free | Deterministic bounded detectors (private keys, prefixed tokens, authorization values, emails, phone numbers, Luhn-valid cards) with explicit placeholder, reserved-domain and test-card allowances limit false positives; rejection happens before any D1/R2 write. Errors carry field paths and categories only; contributed keys that are not plain identifiers or match a detector are shown as `[field #n]`, and JSON Schema failures report location and keyword only. Unprefixed tokens, names, addresses and national identifiers are not detected; stored versions are not rescanned on read. |
| 2026-11-15 | Validate Knowledge source/evidence URLs and declared permission combinations only on contribution creation and versioning | Accept only absolute HTTPS references with well-formed public DNS hostnames outside the IANA special-use registry; make no DNS or HTTP requests. Require an explicit platform-owned tuple policy for source license, permitted use, and data permission, and reject contradictory declarations. These checks accept claims as declared, do not verify ownership or truth, and do not alter immutable reads; any later policy reclassification is a separate quality-state decision. Source resolution, snapshot comparison, and corroboration remain separate work. |
| 2026-11-14 | Validate Knowledge and Execution contributions with separate strict Draft-07 JSON Schemas before accepting them, while retaining family validators for semantic checks | Structural rules reject unsupported fields in both families; the Worker-compatible validator avoids Ajv's runtime code generation, and open maps remain open only where the family contracts allow them. |
| 2026-11-14 | Resolve confirmed development-toolchain advisories with patched ESLint/Vitest releases and a narrowly scoped minimatch override | npm's suggested `typescript-eslint@8.36.0` was not a valid fix: its parser dependency selects minimatch `^9.0.4`, still inside GHSA-g3hv-75wg-m249's affected range. The latest stable typescript-eslint similarly selects minimatch `^10.2.2`; override only that development-only edge to patched minimatch 11 rather than downgrading the toolchain. |
| 2026-11-14 | Defer shared persistent server-side retrieval caching to Phase 6, after Phase 4 authentication and Phase 6 paid-access/entitlement boundaries exist; conditional version checks and transmission avoidance remain complete | There is no authentication or entitlement boundary yet, and a shared cache could leak future paid content. Mutable platform state must not be cached as immutable content. Cached content must not conceal missing, corrupted or inconsistent D1/R2 state. Any future cache key must include immutable contribution ID, version and content hash plus an appropriate authorization scope. |
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
| 2026-11-11 | Agent credentials: opaque token `ac1_<24-hex public id>_<64-hex secret>` (32 random bytes); only a domain-separated SHA-256 digest is stored (no slow KDF or pepper: secret is high-entropy, no secret env exists yet); full token returned once; many credentials per agent for rotation, optional expiry, permanent one-way revocation, non-secret label; verification checks agent/operator status at request time and gives no distinction between unknown id and wrong secret | Safe rotation and revocation without storing recoverable secrets; HTTP authentication and rate limiting are separate Phase 4 work, now implemented for search/get. A keyed pepper remains unapproved. |
| 2026-11-11 | httpbin seed preparation: fixtures are typed data in `src/seed/httpbin.ts` with a pinned-commit source snapshot hashed with SHA-256; one explicit opt-in live check (`npm run seed:verify:httpbin`, never run by tests/CI) gates the Execution `owner-tested` label; Knowledge fixture is `source-checked`; both fixtures declare licence ISC (owner to confirm the contributed-content licence); nothing loaded into D1/R2 | Keeps seeding bounded and honest; loading needs a separate approved loader task and the seed checklist item stays open |
| 2026-11-11 | httpbin seed loading: the owner approved ISC as the contributed-content licence for both seed records; the Execution record is owner-tested only, never independently verified. `seedHttpbinContributions` is idempotent via a same-operator exact content-hash lookup (`findVersionByContentHash`, gated by the active allow-listed actor check) and verifies existing records through normal retrieval before reuse; Execution content embeds the exact stored Knowledge ID and version, so its hash is derived after Knowledge resolves | Safe reruns and partial-state resume without duplicate rows or R2 objects, no general search or API |
| 2026-11-11 | Baseline search ranking is a documented lexicographic SQL `ORDER BY` applied before `LIMIT`: freshness (current before stale; `reviewDueAt` = later of `asOf`/`lastVerifiedAt` + `reviewIntervalDays`, stale at `reviewDueAt` inclusive, injected reference time, exact integer milliseconds), family-aware evidence tier on a common 0–2 scale, `reliabilityScore` (null last), Knowledge corroboration (distinct source URIs beyond the first, cap 4; Execution 0), `created_at DESC`, `contribution_id ASC`. Every key is defined for both families so mixed-family order is total and transitive; no weighted score, no new columns or migration | Deterministic, explainable and testable with existing metadata only; keeps Phase 5 signals as later additions rather than claiming them |
| 2026-11-13 | `retrieval-response/v1` is a separate pure mapper over `RetrievedContribution`; Knowledge `explanation` is passed verbatim only as `untrustedExplanation` (`{label: "untrusted", text}` / `null`), never inside `content`; Execution has no such field | Structural separation lets consumers treat explanation as data; no retrieval, D1/R2 or error-code changes |
| 2026-11-13 | Conditional retrieval in `ContributionRetriever` always runs the full verified exact-version retrieval before comparing the validator; retrieval errors take precedence over a matching validator | A not-modified answer must never vouch for missing, corrupted or inconsistent stored content; skipping verification on a match would conceal tampering |
| 2026-11-13 | Index Knowledge fact predicates and record keys as the original identifier plus deterministically split components (camelCase, acronym, digit boundaries); no stemming, synonyms or Vectorize | Fixes the K2 index-token gap with no query, ranking or migration change; documented that existing local indexes need recreating or reseeding |
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
| Wallet enrollment Sybil identities (cheap EOAs) | Keep the per-IP, per-address and global enrollment rate limits, operator review of every version and the 100-place approval cap; revisit before any trust, feedback-weighting or earnings effect depends on operator distinctness |
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

**Immediate task: Complete remaining Phase 4 acceptance and Phase 5 validation work while keeping feedback reports unverified and trust effects deferred.**

1. Remote MCP is enabled on the pilot and accepted by Claude Code for search, both-family get and Knowledge contribute. Remaining: enroll a second wallet as an independent consumer operator and test remote `commons.feedback`; optionally test Execution contribute through remote MCP. Consider stating the required Knowledge source `hash` in the `commons.contribute` tool description.
2. The minimal exact-version feedback-eligibility receipt is implemented in the shared `commons.get` path. Preserve the boundary: persist only after complete integrity verification and successful full-response budget checking, immediately before returning success; never for search, errors, budget failures or not-modified responses.
3. Keep all accepted feedback unverified; do not apply reliability, freshness, ranking, trust or earnings effects without a separately approved policy.
4. Keep Phase 5 ranking signals deferred until feedback aggregation policy and validated reliability data are approved; Execution reports remain unverified. Persistent shared caching remains assigned to Phase 6, after authentication and paid-access semantics exist.
5. The owner has already provisioned the remote pilot D1/R2 resources, applied migrations and deployed the Worker. Make no further resource or deployment changes without the next explicit operator action. Paid access and caching belong to Phase 6.
6. Agent needs intake is implemented but stays off on the remote pilot because grouped remote review is not available. Preserve the current pilot contribution/review gates. Consider an MCP needs tool only after REST pilot use proves useful.
7. The owner reports that the operator-only remote review interface and reviewer secret are enabled on the pilot. Keep queue, history, capacity and pending content inaccessible through agent credentials, MCP or public Commons operations.
8. PR #81 deployment package is merged. The owner reports the pilot is live and configured with reviewed narrow httpbin and ISC policies; broader policy values remain an operator decision.
9. PR #82 same-origin `/pilot/enroll` page is merged and owner-reported MetaMask acceptance passed on the pilot. It remains EVM EOA-only; ERC-1271 support is separate.

### Pilot launch milestone ("MVP live")

Free, operator-reviewed, 100-place-capped pilot that outside agents can find, enroll in and use. All operations stay authenticated (see Decision Log, 2026-11-16). Payments are out of scope. One bounded task per item, in this order:

- [x] Independent-operator feedback over remote MCP. (2026-11-16: the owner enrolled a second MetaMask account as a separate consumer operator; Claude Code, using that credential, retrieved seed Knowledge `02da40ea-dcdc-4602-825d-109992e148ca` v1 and submitted accuracy `mixed` and staleness `appears_stale` feedback (the live `/get` response now includes `method`); the service returned `accepted: true`. The same request from the contributor operator was refused with `feedback_not_eligible`, as designed.)
- [x] Remote grouped needs review route. (PR #86, merged: reviewer-only `POST /v1/review/needs` and `npm run review:remote -- needs [limit]`, returning the identity-free `NeedsIntake.review()` groups; covered in `test/worker-review.test.ts`. CI `npm run verify` passed on the PR (run #216) and on `main` (run #217).)
- [x] Enable `NEEDS_INTAKE=on` on the pilot. (2026-11-16: owner deployed with `NEEDS_INTAKE=on`; an `unsuccessful_search` report from the independent consumer operator returned `202 accepted`, and `npm run review:remote -- needs` showed one identity-free group with `distinctOperators` 1 and `totalReports` 1. Completes the last Phase 4 acceptance criterion.)
- [x] Low-friction agent onboarding. (PR #88, merged and deployed 2026-11-16: `GET /pilot/agents.md` and alias `/llms.txt` serve the agent-readable guide built from `ENROLLMENT_URI`; while enrollment is on, `401 unauthorized` from `/mcp` and `/v1/commons/*` carries `error.details.onboarding` and a `Link rel="help"` header; the enroll page names the address before signing. Verified live: both paths return `200 text/markdown` with pilot URLs, MCP and needs sections; REST and MCP 401s carry the pointer; both enrolled MCP identities still search normally. CI `npm run verify` passed on the PR. Listing in an MCP registry remains optional and not done.)
- [x] State the required Knowledge source `hash` in the `commons.contribute` tool description. (PR #88: the description now names `uri`, `accessedAt` and `hash` and says new contributions stay pending until review.)
- [x] Seed content. (2026-11-16: 15 records submitted through remote MCP by the contributor agent, owner-approved via `npm run review:remote`, and confirmed searchable and retrievable by the independent consumer operator; capacity 18 used / 82 remaining. httpbin: Knowledge for `/status`, redirects, `/delay`, `/post`, `/response-headers` and Execution diagnostics for `/delay/2` and `/response-headers`. GitHub REST: Knowledge for unauthenticated rate limits, link-header pagination and conditional requests, plus a rate-limit check recipe. PyPI JSON API: Knowledge and a latest-version recipe. Frankfurter: Knowledge and a USD to EUR recipe. Every fact was checked against the live API and each source is pinned to a commit with its SHA-256. The owner extended the pilot policies for this: Execution domains `api.github.com`, `pypi.org`, `api.frankfurter.dev` and redistribute combinations for CC-BY-4.0, Apache-2.0 and MIT. Open-Meteo was excluded because its source is AGPL-3.0. All records remain `listed_unverified`.)
- [x] Pilot usage measurement, first slice. (PR #91, merged and deployed 2026-11-16: reviewer-only `POST /v1/review/usage` and `npm run review:remote -- usage` return identity-free aggregate counts from existing tables; no migration. Live snapshot after deploy: 2 enrolled wallets, 18 listed versions (12 Knowledge, 6 Execution) from 1 contributing operator, 5 retrieval receipts of which 2 came from an operator other than the contributor, 2 feedback reports from 1 operator and 1 needs report, matching the day's recorded activity. Searches and repeat retrievals are not recorded and are reported as `notMeasured`.)
- [x] Count searches and retrievals. (PR #93, merged; migration 0012 applied remotely and deployed 2026-11-16: `usage_daily_counts` holds a UTC day, operation and count only. Verified live: 3 searches and 2 full retrievals made through remote MCP appeared exactly in the snapshot's `activity` section, and a budget-refused get was not counted. CI `npm run verify` passed (Validate run #230).)
- [x] List the pilot in the official MCP Registry. (2026-11-16: the owner withdrew the `[PILOT TEST]` record, then published `server.json` with `mcp-publisher`. The registry API returns `io.github.lankylo/agent-commons` version 0.1.0 with status `active`, the Streamable HTTP `/mcp` URL and the required secret `Authorization` header. The owner chose not to cap sign-ups. 17 records are listed; 18 of 100 approval places are used.)
- [ ] Invite a small set of outside operators; record what they find and what they report missing.


### Software troubleshooting expansion

Scope and conventions are in Section 4, "Domain Expansion: Software Troubleshooting". One bounded task per item, in this order:

- [x] Publish the record convention. (This PR: "Troubleshooting records" in `docs/api.md`, the `commons.search` tool description and the agent onboarding guide. Records use the existing `error-reference` content type, because Knowledge content types are a fixed list. The guide and tool text go live with the next pilot deploy.)
- [x] Decide the search behaviour for long error text. (Owner decision 2026-11-16: keep the 12-token and 256-character limits and guide agents to search the distinctive part of an error. Simply truncating long input would not help, because every query word must match with at most two dropped.)
- [ ] Optional: design a search mode for long pasted error text (match on the most distinctive tokens). Needs its own design and tests; it changes documented search behaviour.
- [x] Source licences for the first batch. (No policy change needed: every record uses a source under MIT, Apache-2.0 or CC-BY-4.0, each checked against the repository's licence file. Dropped because the licence is not in the policy or could not be pinned to one licence: Git's own documentation (GPL-2.0), npm (Artistic-2.0) and the MCP specification (mixed MIT, Apache-2.0 and CC-BY-4.0 during relicensing).)
- [x] Choose the first tools and a reproduction environment. (pip, Node.js, ESLint, Docker Compose, Git and GitHub. Git and SSH errors are reproduced on the authoring machine and marked `owner-tested`; the rest are `source-checked`, because no Node, Python or Docker runtime is installed there.)
- [x] Seed 10–15 owner-reviewed records. (2026-11-16: 10 records approved by the owner; capacity 28 of 100 used and the review queue empty. Verified from the independent consumer identity: an `error-reference` search returned all 10, searches for `Permission denied (publickey)` and `ERR_UNSUPPORTED_DIR_IMPORT` each returned the matching record first, and a full get of the pip externally-managed-environment record passed integrity checks. Records: pip externally-managed-environment and ResolutionImpossible; Node.js ERR_REQUIRE_ESM deprecation and ERR_UNSUPPORTED_DIR_IMPORT; ESLint missing eslint.config and unsupported eslintrc keys; Docker Compose obsolete `version`; Git push rejected; GitHub SSH publickey denial; GitHub password authentication removal. Not written: TypeScript option deprecations and the Compose v1 command change, whose sources could not be located at a pinned commit.)
- [ ] Add a breakdown of listed versions and retrievals by content type to the usage snapshot, so troubleshooting records can be compared with API records. (In review: `byContentType` in `pilot-usage/v1`, computed from existing tables with no migration. Tick after the pilot deploy shows it.)
- [ ] After two weeks, look at searches, retrievals, feedback and needs reports for the two content areas and use them to choose what to add next. This informs direction; it is not a gate on continuing.
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

**Current phase:** Phase 4 completed (2026-11-16): REST, local stdio MCP and remote MCP serve all four tools; remote MCP, independent-operator feedback and needs intake with remote grouped review are verified on the pilot. Phase 5 In Progress; Phase 3 remains complete.
**Last completed task:** First software troubleshooting batch (2026-11-16): 10 `error-reference` records approved and verified searchable and retrievable from the independent consumer identity; the record convention and search guidance are merged with this PR and go live at the next pilot deploy. Before that, public listing in the official MCP Registry, verified through the registry API. The search and retrieval counter (PR #93), usage snapshot (PR #91), seed content, agent onboarding (PR #88) and Phase 4 were completed earlier the same day.

**Current task:** None in progress. Independent-operator remote feedback passed and remote grouped needs review is merged (PR #86).

**Known blockers:** None for Phase 4. Phase 5 acceptance remains incomplete; payments (Phase 6) are outside the pilot launch milestone.
**Next task:** Continue the software troubleshooting expansion (Section 10): add the content-type breakdown to the usage snapshot, then further record batches. Keep watching the public pilot's queue, needs reports and usage snapshot. Make no further deployment changes without a separate operator action.

**Last verified implementation:** PR #86 (remote grouped needs review) passed CI `npm run verify` on its branch (run #216) and on `main` after merge (run #217). PR #83 branch at `247222e` passed Linux `npm run verify`: typechecks, formatting, lint, 920 tests across 56 files and Wrangler dry run. The local Windows mirror also passed 37 focused tests with test-launch adaptations. PR #82 was merged; its earlier verify passed 909 tests across 54 files.

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
