# Search-Quality Report (Phase 3)

Offline benchmark of the existing internal D1 FTS5 search (`src/registry/search.ts`) with realistic
agent-style queries over both contribution families. Deterministic, LLM-free, no network, and
independent of R2 content (the search service is constructed with D1 only). The baseline results were
measured before any production change; the second run after the deterministic query-normalization
change in `src/registry/search.ts` (PR #43); the final run after structured-identifier index terms
in `src/registry/search-document.ts` (this change). The corpus, queries, relevance judgements,
thresholds and expected results are unchanged between all runs.

Files: `test/registry/search-quality-benchmark.ts` (corpus, cases, scoring harness),
`search-quality.test.ts` (runs the cases on local Miniflare D1 with the real migrations and pins the
observed behaviour), `search-quality-harness.test.ts` (scoring unit tests, no D1).
Reference time: `2026-11-20T00:00:00Z`.

## Verdict

**The acceptance criteria are met.** All 25 cases pass: top-1 22/22 = 100% (≥ 80%), top-3 22/22 =
100% (≥ 90%), 0 missed, 0 misplaced, 0 unexpected, 0 ordering violations, 0 positive zero-result
queries and 0 non-empty no-result cases. The Phase 3 checklist item "Test search quality…" is complete.

## Corpus (21 contributions, all schema-valid, created through `ContributionRegistry`)

Knowledge (10): `k-httpbin` (seed, source-checked), `k-github-rate` (cross-source, current),
`k-github-rate-old` (unverified, **stale**), `k-retry-after`, `k-idempotency` (cross-source),
`k-json-pointer`, `k-httpbin-post` (distractor), `k-d1-limits`, `k-oauth-token`, `k-http-etag`
(reference-only).
Execution (11, incl. seed): `e-httpbin` (seed, owner-tested, read-only), `e-github-rate` (read-only),
`e-github-issue` (reversible-write, approval), `e-github-delete` (irreversible-write, approval,
simulated), `e-retry-after`, `e-oauth-token` (simulated), `e-payment-idempotency` (irreversible-write,
approval), `e-http-etag` (unverified), `e-mtls-status` (capability `mtls`), `e-httpbin-post`
(distractor), `e-httpbin-headers-old` (unverified, **stale**).
Overlapping topics (GitHub rate limits, httpbin, idempotency, 429/Retry-After, ETag) exist in both
families; httpbin and GitHub entries are distractors for each other.

## Metrics and acceptance criteria

Positive cases have at least one relevant contribution; no-result cases expect zero results.
- **top-1 success**: rank 1 is relevant. **top-3 success**: at least min(#relevant, 3) relevant items are in ranks 1–3.
- **missed**: relevant item not returned. **misplaced**: returned below its stated `maxRank`.
- **unexpected**: returned item neither relevant nor listed as acceptable. **zero-result**: positive case returning nothing (or a no-result case returning something).

| Criterion | Threshold |
|---|---|
| top-1 rate (positive cases) | ≥ 80% |
| top-3 rate (positive cases) | ≥ 90% |
| missed relevant, misplaced relevant | 0 |
| zero-result positive cases; non-empty no-result cases | 0 |
| unexpected results; ordering violations | 0 |

## Query cases (25) and observed ranking (final)

Expected = relevant item(s) with max rank; observed = returned order. All requests are sent verbatim.

| Case | Query / filters | Expected | Observed | Result |
|---|---|---|---|---|
| K1 | `httpbin get contract` (knowledge) | k-httpbin ≤1 | k-httpbin | pass |
| K2 | `what status code and fields does httpbin get return` | k-httpbin ≤1 | k-httpbin | pass (baseline and PR #43: none, fail) |
| K3 | `github rate limits` (knowledge) | k-github-rate ≤1 | k-github-rate, k-github-rate-old | pass |
| K4 | `how many unauthenticated requests per hour does the github api allow` | k-github-rate ≤1 | k-github-rate, k-github-rate-old | pass (baseline: none, fail) |
| E1 | `github issue` (execution) | e-github-issue ≤1 | e-github-issue | pass |
| E2 | `I need a recipe to check my github api rate limit` (execution) | e-github-rate ≤1 | e-github-rate | pass (baseline: none, fail) |
| E3 | `oauth access token` (execution) | e-oauth-token ≤1 | e-oauth-token | pass |
| M1 | `idempotency key` | k-idempotency, e-payment-idempotency ≤3 | both, ranks 1–2 | pass |
| M2 | `retry after 429` | k-retry-after, e-retry-after ≤3 | e-retry-after, k-retry-after | pass |
| M3 | `etag` | k-http-etag, e-http-etag ≤3 | k-http-etag, e-http-etag | pass |
| F1 | `httpbin` (execution) | e-httpbin, e-httpbin-post ≤2 | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| F2 | `github rate limits` + verificationMethod=cross-source | k-github-rate ≤1 | k-github-rate only | pass |
| F3 | `httpbin` + permittedUse=redistribute (knowledge) | k-httpbin ≤1 | k-httpbin only | pass |
| F4 | `httpbin`, contentType=diagnostic-recipe | e-httpbin, e-httpbin-post ≤2 | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| S1 | `github` + sideEffect=read-only | e-github-rate ≤1 | e-github-rate only | pass |
| S2 | `payment` + sideEffect=irreversible-write | e-payment-idempotency ≤1 | that only | pass |
| S3 | `github` + requiresHumanApproval=false | e-github-rate ≤1 | e-github-rate only | pass |
| C1 | `status` + requiredCapability=mtls | e-mtls-status ≤1 | that only | pass |
| C2 | `post echo` + targetDomain=httpbin.org | e-httpbin-post ≤1 | that only | pass |
| R1 | `github rate` (stale must trail current) | k-github-rate, e-github-rate ≤3 | k-github-rate, e-github-rate, k-github-rate-old | pass |
| R2 | `httpbin diagnostic` (execution) | e-httpbin, e-httpbin-post ≤2; current before stale | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| R3 | `httpbin` (all five httpbin items ≤5; current before stale) | see corpus | e-httpbin-post, e-httpbin, k-httpbin, k-httpbin-post, e-httpbin-headers-old | pass |
| N1 | `kubernetes pod autoscaling` | none | none | pass |
| N2 | `github` + knowledge + permittedUse=redistribute | none | none | pass |
| N3 | `quantum` (execution) | none | none | pass |

Authoring note: the first R2/R3 drafts listed only `e-httpbin`/`k-httpbin` as relevant and marked
`e-httpbin-post` unexpected. `httpbin diagnostic` legitimately matches `e-httpbin-post` (its content
type is `diagnostic-recipe`) and `httpbin` matches all five httpbin items, so those expectations were
corrected as a relevance-judgement error. No expectation was changed to accommodate the failures, and
no query was reworded, including for the post-change run.

## Measured results

| Measure | Baseline | After normalization (PR #43) | Final (identifier terms) |
|---|---|---|---|
| Cases (positive / no-result) | 25 (22 / 3) | 25 (22 / 3) | 25 (22 / 3) |
| Top-1 success | 19 / 22 = 86.4% | 21 / 22 = 95.5% | 22 / 22 = 100% (≥ 80%: **met**) |
| Top-3 success | 19 / 22 = 86.4% | 21 / 22 = 95.5% | 22 / 22 = 100% (≥ 90%: **met**) |
| Missed relevant results | 3 of 33 | 1 of 33 (K2) | 0 of 33 (**met**) |
| Misplaced relevant results | 0 | 0 | 0 |
| Unexpected results | 0 of 35 returned | 0 of 38 returned | 0 of 39 returned |
| Ordering violations (freshness, evidence tier) | 0 | 0 | 0 |
| Zero-result queries | 3 positive | 1 positive (K2) | 0 positive; 0 non-empty no-result (**met**) |
| Cases fully passed | 22 / 25 | 24 / 25 | 25 / 25 |

## Findings

K4 and E2 were fixed by PR #43 (stop words, singular/plural forms, bounded relaxation: at most two
groups dropped, at least three kept, only when the strict query returns nothing).

K2 was a vocabulary/index-token gap: the httpbin seed stores structured predicates in camelCase
(`successStatus`, `responseFields`), which are single FTS5 `unicode61` tokens, so `status` and
`fields` did not occur as index tokens. `buildSearchText` now indexes each Knowledge fact predicate
and record key as the original identifier **plus** its separated components (`successStatus success
Status`), using the deterministic `splitIdentifier` helper (camelCase, PascalCase, acronym and
letter/digit boundaries, `_ - .` separators). No stemming or synonyms; contributed prose, values,
titles, explanation, sources, evidence, licensing, identities, hashes, timestamps, raw JSON and
Execution steps are not split or newly indexed. The K2 query is unchanged, and query normalization,
bounded relaxation, filters, ranking and limits are unchanged. K2 now returns `k-httpbin` at rank 1.
Concise keyword, family, metadata, compatibility, safety, freshness and tie-break behaviour is
unchanged: filters never leaked other families or unsafe recipes, stale items trailed current ones,
and repeated runs were identical.

**Existing indexes:** the migrations are unchanged, and the search documents are immutable per
version. No remote D1 database exists, so any previously created *local* search index must be
recreated (fresh local D1) or reseeded to receive the additional derived terms; older documents are
not rewritten.

## Limitations

- Small corpus (21 items) written by the benchmark author; queries are hand-written to resemble agent output, not sampled from real agents.
- Relevance judgements are the author's; the ranking order among equally relevant items (e.g. `e-httpbin-post` before `e-httpbin`) is accepted rather than judged.
- Ranks reflect only the Phase 3 baseline signals; Phase 5 signals (outcomes, feedback, reliability) do not exist yet, and no `reliabilityScore` is populated.
- Measures lexical retrieval only; no latency, scale or large-corpus behaviour.

## Recommendation

D1 FTS5 with deterministic query normalization and identifier index terms meets the Phase 3 search
acceptance criteria on this benchmark, so Vectorize is not needed and is not added. Re-run this
benchmark unchanged whenever the index or query logic changes; broaden the corpus with real agent
queries before relying on these figures at scale.
