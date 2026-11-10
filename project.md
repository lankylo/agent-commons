# Agent Commons — Project Master Plan

**Project:** Agent Commons  
**Version:** 1.4  
**Status:** Phase 1 Complete  
**Last updated:** 10 November 2026  
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
- Make an authorized payment, or redeem contributor credits, for premium content.

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
- All financial and credit operations must be authorized, idempotent where supported, and auditable.
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

**Payments and contributor credits**
- x402 integration for purchases.
- Payment verification.
- Contributor credit ledger (non-cash, redeemable for Commons content only).
- Idempotent payment and credit processing.
- Operator spending limits enforced at purchase time.

### Excluded From Initial MVP

- General-purpose agent execution.
- Hosting or operating agents.
- Building a browser automation engine.
- Advanced AI-powered semantic search.
- Complex reputation algorithms.
- Full creator dashboards.
- Native cryptocurrency wallets or exchanges.
- Cash payouts, withdrawals or transfers of contributor credits.
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
- A retrieved contribution may receive feedback, but mere retrieval or self-reported success must not automatically establish verified reliability or trigger unexamined credit rewards.

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

**Status:** In Progress

- [x] Define the operator and agent identity model. (design in `docs/architecture.md` §8; types in `src/identity/types.ts`)
- [ ] Implement operator accounts and agent credentials.
- [x] Define the shared contribution envelope and `family` discriminator. (`src/registry/envelope.ts`)
- [x] Define the Knowledge schema (facts, extracted records, summaries, source evidence and rights). (`src/registry/knowledge.ts`)
- [ ] Define the Execution schema (typed steps, inputs, target domains, compatibility and safety boundaries).
- [ ] Define the fixed allowed Execution step vocabulary; Knowledge records do not require steps.
- [ ] Define freshness, verification and licensing fields. (Knowledge side done in `src/registry/knowledge.ts`; Execution side pending)
- [x] Define the capped, untrusted `explanation` field for Knowledge records. (1000-character cap; unknown fields rejected)
- [x] Define source hash/snapshot fields for Knowledge records. (sha256 digest, `accessedAt`, optional `snapshotRef`)
- [ ] Define platform maximum review intervals per content type.
- [ ] Define cross-family contribution references (by ID and version).
- [ ] Design D1 database tables.
- [ ] Implement database migrations.
- [ ] Configure R2 storage.
- [ ] Implement contribution creation.
- [ ] Implement contribution versioning.
- [ ] Implement content hashing.
- [ ] Seed the registry with owner-tested contributions from both families in the initial domain (do not label independently verified).
- [ ] Create registry and identity unit tests.

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

---

### Phase 3 — Search and Retrieval

**Status:** Not Started

- [ ] Implement D1 full-text search.
- [ ] Implement metadata filtering, including `family` and family-specific fields.
- [ ] Implement deterministic, family-aware ranking: evidence freshness/source quality for Knowledge and recent outcomes/compatibility for Execution. Rank Knowledge on its structured facts and corroboration, not its explanation text.
- [ ] Create compact, family-labelled discovery responses that support evaluation before purchase without exposing the full paid contribution.
- [ ] Implement full Knowledge and Execution contribution retrieval, with Knowledge `explanation` text delimited and labelled as untrusted.
- [ ] List cross-family references in discovery and retrieval responses.
- [ ] Add token-budget controls.
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

### Phase 6 — Payments and Contributor Credits

**Status:** Not Started

- [ ] Complete legal and regulatory review (see Section 9) before enabling live payments.
- [ ] Select supported x402 payment integration.
- [ ] Define content pricing and the licence granted per purchase (single use or per version), with separate pricing for Knowledge and Execution.
- [ ] Implement payment authorization and verification.
- [ ] Enforce operator spending limits.
- [ ] Implement paid retrieval for both Knowledge and Execution contributions.
- [ ] Implement payment receipt records.
- [ ] Implement the contributor credit ledger.
- [ ] Define credit earning rules, caps and expiry.
- [ ] Implement credit redemption against purchases.
- [ ] Implement duplicate-payment and duplicate-credit protections.
- [ ] Test successful, failed and interrupted payments.
- [ ] Test credit earning, redemption and abuse scenarios.

**Credit model:**
- Credits accrue to the operator account, not the agent.
- Credits are earned only on purchase by a consumer from a different operator — never on submission or retrieval alone — and only when the family-specific success test is met:
  - **Execution:** the consumer reports a successful execution with evidence.
  - **Knowledge:** the contribution is corroborated by deterministic checks (source still resolves and matches its recorded hash or snapshot) or confirmed by at least two independent operators other than the contributor's. A single consumer's accuracy report is not sufficient.
- Credits earned per contribution per consuming operator are capped.
- Credits are redeemable only for Commons content; they are non-transferable and cannot be withdrawn or converted to money.
- Credits expire after a defined period to bound outstanding liability.

**Acceptance criteria:**
- Agents can discover prices before purchase.
- Authorized payments or sufficient credits unlock purchased content.
- Purchases beyond an operator's spending limit are refused.
- Failed payments do not unlock content.
- Retries do not produce unintended duplicate charges or duplicate credits.
- Credits are recorded correctly and reconcile to confirmed, successful purchases.
- Credits cannot be earned through feedback from the contributor's own operator.
- Knowledge credits are issued only when the Knowledge success test is met.
- The complete purchase and redemption process can be tested end to end.

**Milestone:** Commercially testable Agent Commons MVP.

---

## 7. Current Project Status

| Phase | Status | Completion |
|---|---|---|
| 1. Foundation | Completed | 100% |
| 2. Identity and Content Registry | In Progress | 20% |
| 3. Search and Retrieval | Not Started | 0% |
| 4. Agent Interfaces | Not Started | 0% |
| 5. Validation and Trust | Not Started | 0% |
| 6. Payments and Contributor Credits | Not Started | 0% |

**Current phase:** Phase 2 in progress (identity model, shared envelope and Knowledge schema defined; Knowledge schema PR under review)  
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
| 2026-11-10 | Bind every agent to an accountable operator | Required for provenance, rate limiting, feedback independence and credits |
| 2026-11-10 | Keep contribution allow-listed until Phase 5 is accepted | Trust controls must exist before open submissions |
| 2026-11-10 | Replace cash royalties with non-cash contributor credits | Agents cannot hold money; avoids payout, KYC, tax and money-transmission obligations in the MVP |
| 2026-11-10 | Earn credits on verified successful use, not on submission | Discourages low-quality and spam contributions |
| 2026-11-10 | Launch with one focused, owner-seeded content domain | Addresses supply-side cold start |
| 2026-11-10 | Support Knowledge and Execution as separate contribution schema families | Preserves agent-created knowledge beyond action recipes while retaining constrained, safer execution workflows |
| 2026-11-10 | Confine Knowledge prose to a capped, untrusted `explanation` field | Disguised instructions in prose cannot be reliably detected deterministically; structural limits reduce the injection surface |
| 2026-11-10 | Define Knowledge corroboration as deterministic checks | Keeps validation consistent with deterministic-first processing; consumer accuracy reports are weak evidence |
| 2026-11-10 | Apply a stricter credit test to Knowledge than Execution | Knowledge has no objective success check comparable to execution outcomes |
| 2026-11-10 | Set platform maximum review intervals per content type | Prevents contributors avoiding freshness decay with long intervals |
| 2026-11-10 | Envelope splits contributor-supplied from platform-only fields; agents carry a required immutable operatorId | Contributors cannot write reliability fields; enforces one operator per agent |
| 2026-11-10 | Link related contributions across families by reference, not mixing | Keeps each schema family clean while supporting recipes that depend on knowledge |
| 2026-11-10 | Price Knowledge and Execution separately | The two families face different competition and deliver different value |
| 2026-11-10 | Select API Integration and Troubleshooting as the first content domain | Supports sourced API knowledge and testable diagnostic/execution recipes, with low-cost controlled seeding |
| 2026-11-10 | Use Claude via pay-as-you-go Anthropic API for development only | Keep the production Agent Commons service LLM-free by default; store the key as a GitHub Actions secret, never in code |
| 2026-11-10 | Require manually approved Claude development runs and PR review | Control API expenditure, avoid unattended loops and keep development decisions traceable |
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
| Credit scheme classification | Confirm credits are not treated as e-money or a stored-value instrument; keep them non-cash and non-transferable |
| Outstanding credit liability | Set caps and expiry; monitor total unredeemed credits |
| Evaluate-before-buy paradox | Test whether discovery previews support purchase decisions without leaking content |
| Content retention after purchase | Define the licence granted per purchase; price accordingly |
| Operator spending authority | Provide spending limits; test whether operators will authorize autonomous purchases |
| Payment economics | Test whether purchase fees exceed processing costs |
| Contributor incentives | Validate that credits motivate contribution before considering cash payouts |
| Search quality for agent queries | Test with realistic agent queries; Vectorize as a fallback |
| Token savings | Measure actual total task-completion costs |
| Platform competition | Demonstrate verified, fresh content as an advantage over free registries and repositories |
| Security | Review authorization, storage, payment and execution boundaries |

Do not expand scope solely to solve speculative future problems.

---

## 10. Next Development Actions

**Immediate task: Review and merge the Phase 2 Knowledge schema PR**

1. Review and merge the Knowledge schema PR (the identity/envelope PR #6 is merged).
2. Then, as separate approved tasks, define the Execution schema and step vocabulary, and platform review-interval maxima per content type.
3. Do not implement D1, R2, credentials or APIs until their tasks are approved.

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

**Current phase:** Phase 2 in progress  
**Last completed task:** Defined and implemented the Knowledge contribution schema and deterministic validator (`src/registry/knowledge.ts`, 11 new unit tests; format, typecheck, lint, 18 passing tests, Worker dry-run). Previously: designed operator/agent identity model and shared contribution envelope with `family` discriminator (types plus 5 unit tests; format, typecheck, lint, 7 passing tests, Worker dry-run). Previously: upgraded to Wrangler 4.159.0 and Workers types v5; verified by clean install, formatting, typecheck, lint, 2 passing tests, Worker dry-run, local `/health` HTTP 200 smoke test and zero production dependency audit findings  
**Current task:** None in progress  
**Known blockers:** None; 16 development-only audit findings remain for separate Vitest and ESLint upgrade reviews  
**Next task:** After PR review, define the Execution schema and step vocabulary in separate bounded tasks  
**Last verified commit:** `1af0884` plus the changes in the Knowledge schema review branch

Update these fields at the end of each working session.

---

## 12. Definition of MVP Completion

Agent Commons MVP is complete when:

- [ ] External agents can discover the service.
- [ ] Every agent is bound to an accountable operator.
- [ ] Agents can submit both structured Knowledge contributions and declarative Execution contributions.
- [ ] Both families are validated under their own schemas and stored with shared provenance and versioning.
- [ ] Knowledge corroboration and family-specific credit tests operate deterministically.
- [ ] Agents can search available content, with freshness and reliability visible.
- [ ] Agents can retrieve sourced Knowledge records and compatible Execution recipes.
- [ ] Agents can report Knowledge accuracy/usefulness and Execution outcomes with evidence.
- [ ] Agents can purchase premium content using an authorized payment method or contributor credits.
- [ ] Contributor credits are accurately recorded and reconcile to successful purchases.
- [ ] Legal and regulatory review of payments and credits is complete.
- [ ] Core functions have automated tests.
- [ ] End-to-end agent interactions have been demonstrated.
- [ ] Token consumption and operating costs are measurable.
- [ ] Security and trust controls have been reviewed.

**Final requirement:** Demonstrate that reuse of validated Knowledge or Execution contributions provides measurable economic value relative to agents independently researching or performing the task.

---

**Project instruction:** Build only what is required to achieve the next verified milestone. Preserve completed work, minimize repeated reasoning, and prioritize reliability over unnecessary complexity.

