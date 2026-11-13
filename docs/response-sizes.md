# Response-Size Report (Phase 3)

Exact serialized sizes of the internal discovery and retrieval contracts, pinned by
`test/registry/response-size.test.ts` (deterministic, offline).

**Method.** Size = UTF-8 bytes of `JSON.stringify(response)` measured with `TextEncoder`, the same
convention as `discovery-budget.ts` and `retrieval-budget.ts`. Bytes are a deterministic,
model-independent **proxy** for token cost only; no token counts, default budgets or product limits
are defined here. Budget metadata is returned beside responses and is not part of these sizes.

## Fixtures

| Name | Description |
|---|---|
| httpbin Knowledge / Execution | The existing seed contributions (`src/seed/httpbin.ts`) |
| large Knowledge | Schema-valid: 100 facts, 100 records × 10 fields, 600-char summary, 1000-char explanation; multibyte (2-, 3- and 4-byte UTF-8) text throughout |
| large Execution | Schema-valid: 50 steps (1 request, 24 extractions, 25 assertions); multibyte text in title, purpose and objective (Execution literals are ASCII-only by schema) |
| discovery, 2 results | The two httpbin results |
| discovery, 10 results | Alternating Knowledge/Execution items, multibyte titles, 300-char purposes |

Retrieval fixtures use a 26-character contribution ID, version 3, one related reference and
unset platform evidence; sizes vary with those values.

## Measured sizes (bytes)

| Response | Bytes |
|---|---|
| `discovery-response/v1`, empty | 70 |
| `discovery-response/v1`, httpbin (2 results) | 873 |
| `discovery-response/v1`, 10 multibyte results | 5670 (567 per result) |
| `retrieval-response/v1`, httpbin Knowledge | 2206 |
| `retrieval-response/v1`, httpbin Execution | 2071 |
| `retrieval-response/v1`, large Knowledge | 87385 |
| `retrieval-response/v1`, large Execution | 7770 |
| `retrieval-not-modified/v1` (any fixture) | 184 |

### `retrieval-not-modified/v1` savings

| Full response replaced | Saved bytes | Reduction |
|---|---|---|
| httpbin Knowledge | 2022 | 91.7% |
| httpbin Execution | 1887 | 91.1% |
| large Knowledge | 87201 | 99.8% |
| large Execution | 7586 | 97.6% |

## Budget behaviour (verified)

- **Discovery:** a budget equal to a prefix's exact size keeps that prefix; one byte less keeps the
  next-shorter prefix. The largest ranked prefix that fits is kept, in ranked order, with whole
  results only; an oversized result is never skipped to fit a later one. A budget below the empty
  response (70 bytes) returns `budget_too_small`.
- **Retrieval:** all-or-nothing. Exact size is accepted; one byte less returns
  `response_too_large` (with maximum and required bytes) and no response. Content and the untrusted
  explanation are never truncated.

## Conclusions

1. Contribution size dominates retrieval cost: the schema maxima produce responses of ~87 KB
   (Knowledge) versus ~2 KB for the seeds. Discovery costs ~0.5–0.6 KB per result.
2. `retrieval-not-modified/v1` is constant-size (184 bytes for these IDs) and saves 91–99.8% of a
   full response when the validator matches.
3. Because retrieval never truncates, a caller whose budget is below the required bytes must
   raise it or skip the item; discovery degrades by dropping lowest-ranked results.
4. No production defect was found; no production code changed.
