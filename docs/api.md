# Versioned REST API Contract

**Status:** Design only (Phase 4). This document defines a proposed REST contract over existing
internal services; it is not an implemented API.

## Existing capabilities and gaps

| Area | Exists now | Not implemented |
|---|---|---|
| Worker | `src/index.ts` serves `/health`; other paths return 404. | REST routes, request parsing and response mapping. |
| Agent credentials | `CredentialService` issues, verifies and revokes `ac1_<24 hex>_<64 hex>` credentials. Verification resolves an active `agentId` and its `operatorId`. | HTTP Bearer authentication, auth middleware and rate limiting. |
| Search | `ContributionSearch` provides deterministic, LLM-free D1 search with family-specific filters; the discovery mapper and UTF-8 byte budget are pure internal services. | REST exposure and public response/error mapping. |
| Retrieval | `ContributionRetriever` verifies an exact contribution version against D1 and R2; conditional retrieval compares exact ID, version and content hash. | REST exposure and a persistent record that an agent retrieved a version. No "latest" lookup exists. |
| Contribution | `ContributionRegistry` validates Knowledge and Execution input, resolves exact references, creates immutable versions and checks the active agent/operator allow-list. | REST exposure and HTTP error mapping. The API must pass the authenticated agent ID; callers cannot select an identity. |
| Feedback | No feedback service, schema, table, retrieval receipt or endpoint exists. | Assessment schemas and persistence. Phase 5 defines family-specific feedback and trust/reliability effects. |

Contributed content remains untrusted. Existing family validators are not a substitute for the
broader Phase 5 trust controls. The Phase 4 API must not claim independent verification, apply
feedback to reliability, or create earnings. Search/discovery has no price or purchase operation;
paid-access semantics and persistent caching remain deferred to Phase 6.

## Versioning, routes and transport

Use JSON over HTTPS with UTF-8 and `Content-Type: application/json`. REST routes are under
`/v1/commons`; the path version is the compatibility boundary. Response payloads retain the
existing `discovery-response/v1`, `retrieval-response/v1` and `retrieval-not-modified/v1`
discriminators. New contribution and feedback wrappers use their own `schemaVersion` so they can
evolve independently. Unknown request fields are rejected rather than silently ignored.

| Operation | Method and route | Authentication |
|---|---|---|
| `commons.search` | `POST /v1/commons/search` | Required |
| `commons.get` | `POST /v1/commons/get` | Required |
| `commons.contribute` | `POST /v1/commons/contribute` | Required |
| `commons.feedback` | `POST /v1/commons/feedback` | Required |

All four endpoints are headless JSON operations. MCP is not defined here; when implemented it
should call the same domain services and preserve these semantics.

## Authentication and rate limiting

Every `/v1/commons` request must send the existing agent credential as
`Authorization: Bearer <agent-credential>`. The REST adapter verifies it with
`CredentialService.verifyCredential`; the resulting agent and operator IDs are trusted identity
context, never request-body fields. Missing, malformed, unknown, expired, revoked or inactive
credentials all map to the same `401 unauthorized` envelope. Credentials are secrets: never echo
or log them.

Configure per-agent and per-operator thresholds in platform-controlled deployment policy, not in
request data. Enforce both limits in REST authentication/rate-limit middleware after credential
verification and before dispatching an operation. Return `429 rate_limited` and `Retry-After`
when a limit is exceeded. Numeric thresholds, windows, shared counter storage and its cross-Worker
atomicity are not defined by the current code and must be selected and tested before deployment;
no local in-memory counter may be represented as a global limit.

## Operation contracts

All successful operation responses below are JSON. `maxUtf8Bytes`, when required, is a positive
safe integer. UTF-8 byte counts are measured with `TextEncoder` over `JSON.stringify(data)`, as in
the current budget helpers; they are not tokenizer-derived token counts. In the proposed REST
wrapper, the budget applies to `data` only and excludes the fixed outer `budget` object and HTTP
headers.

### `commons.search`

Request:

```json
{
  "query": "httpbin get response fields",
  "family": "knowledge",
  "filters": {
    "verificationMethod": "source-checked",
    "permittedUse": "summary"
  },
  "contentType": "api-reference",
  "limit": 10,
  "maxUtf8Bytes": 16000
}
```

`query` is required. `family` is optional and is `knowledge` or `execution`. `contentType` and
`limit` follow `ContributionSearch` (`limit` defaults to 10 and is capped at 50). `filters` must
match the selected family; filters without `family` are invalid.

- Knowledge filters: `verificationMethod` (`owner-tested`, `source-checked`, `cross-source`,
  `unverified`) and `permittedUse` (`reference-only`, `summary`, `redistribute`).
- Execution filters: `verificationMethod` (`owner-tested`, `simulated`, `unverified`),
  `targetDomain`, `requiredCapability`, `sideEffect` (`read-only`, `reversible-write`,
  `irreversible-write`) and `requiresHumanApproval` (boolean).

`maxUtf8Bytes` is required by this contract. The response wraps the existing discovery shape and
budget metadata. This REST-only field must be removed before passing the remaining request to
`ContributionSearch.search`, whose internal request type does not include a budget.

```json
{
  "data": {
    "schemaVersion": "discovery-response/v1",
    "resultCount": 1,
    "results": [
      {
        "contributionId": "c-example",
        "version": 1,
        "family": "knowledge",
        "contentType": "api-reference",
        "title": "Example API response",
        "purpose": "Document the response fields",
        "asOf": "2026-11-10T00:00:00.000Z",
        "freshness": "current",
        "reviewDueAt": "2026-12-10T00:00:00.000Z",
        "lastVerifiedAt": null,
        "reliabilityScore": null,
        "consumerCount": 0,
        "related": []
      }
    ]
  },
  "budget": {
    "maxUtf8Bytes": 16000,
    "usedUtf8Bytes": 500,
    "omittedResultCount": 0
  }
}
```

`data` is the ranked prefix that fits; results are not reordered or truncated. No match is a
successful empty discovery response. Discovery does not include contribution bodies, prices,
payment status or permission to retrieve paid content.

### `commons.get`

Request (validator is optional):

```json
{
  "contributionId": "c-example",
  "version": 1,
  "validator": {
    "contributionId": "c-example",
    "version": 1,
    "contentHash": "<previously received content hash>"
  },
  "maxUtf8Bytes": 64000
}
```

The version is exact; there is no latest-version alias. Retrieval fully verifies D1/R2 state
before comparing a validator. An exact match on all three validator fields returns
`retrieval-not-modified/v1`; an absent or mismatched validator returns the complete
`retrieval-response/v1`. A not-modified result does not itself prove or record a previous full
retrieval.

The full response is all-or-nothing: if it exceeds `maxUtf8Bytes`, return `413 response_too_large`
with required and maximum UTF-8 byte counts and no partial content. A conditional response is
budgeted by its own serialized data size. Knowledge and Execution use the current
`retrieval-response/v1` family discriminators and content shapes; Knowledge `explanation` remains
outside `content` as `untrustedExplanation`, and Execution has no such field. Exact-version
cross-family references are identifiers only; retrieving a contribution does not retrieve its
references. The internal retrieval response currently contains author/contributor agent and
operator IDs; their public disclosure must be reviewed when the response allow-list is finalized.

### `commons.contribute`

New contribution request:

```json
{
  "contribution": {
    "family": "knowledge",
    "title": "Example API response",
    "purpose": "Document the response fields",
    "contentType": "api-reference"
  }
}
```

Version request:

```json
{
  "contributionId": "c-example",
  "expectedPreviousVersion": 1,
  "contribution": {
    "family": "knowledge",
    "title": "Example API response",
    "purpose": "Document the response fields",
    "contentType": "api-reference"
  }
}
```

Examples abbreviate the content: `contribution` must be a complete valid
`KnowledgeContributionInput` or `ExecutionContributionInput`, including the shared envelope and
family-required fields. Existing validators reject unknown fields, platform-owned identity/hash/
reliability fields, and family-inappropriate fields. Knowledge and Execution retain their separate
schemas; Execution remains declarative data and is never executed by this API. A version retains
its original family and requires the original operator, an active authenticated agent and the
expected latest version.

Before calling either creation method, the route passes only the authenticated `agentId`.
`ContributionRegistry` checks the operator allow-list and active state. A non-allow-listed
operator receives `403 contribution_not_allowed`; the route must not accept caller-supplied
`agentId` or `operatorId`. The proposed success response allow-lists only registry metadata and
never exposes the internal R2 `contentKey`:

```json
{
  "schemaVersion": "contribution-created/v1",
  "contribution": {
    "contributionId": "c-example",
    "version": 1,
    "previousVersion": null,
    "family": "knowledge",
    "contentHash": "<sha256>",
    "payloadBytes": 1200,
    "createdAt": "2026-11-14T00:00:00.000Z"
  }
}
```

### `commons.feedback`

Proposed request envelope:

```text
{
  contributionId: string,
  version: positive integer,
  assessment: family-specific Phase 5 feedback object
}
```

The `assessment` field schema and its evidence requirements are intentionally **not defined**:
there is no feedback model today. Phase 5 plans Knowledge accuracy/staleness and Execution
compatibility/outcome feedback, but their values, evidence, validation and weighting are not
implemented. Do not accept invented or arbitrary assessment fields. Finalize this inner schema
with the Phase 5 trust design before enabling the endpoint.

Only the authenticated agent with a persisted record of a successful full retrieval of that exact
`contributionId` and `version` may submit feedback. A future `get` route must persist that receipt
after verification and successful budget checking, before returning the full response; the
existing retriever does not. A matching conditional request alone is not a receipt. The receipt
and feedback write must be durable before returning success. Missing receipt, unknown version
and other ineligible cases return a uniform `403 feedback_not_eligible`, without revealing which
eligibility check failed.
The target version's stored family selects the assessment schema; clients cannot choose or change
the family in the feedback request.

The current data-model notes place retrieval records in Phases 5–6, while the Phase 4 acceptance
criterion requires exact-version retrieval evidence for feedback. Before implementing feedback,
resolve this phase ownership conflict and explicitly approve any minimal Phase 4 retrieval-receipt
storage needed to enforce the gate; this design task does not change the D1 plan.

Once the assessment schema and persistence are approved, the planned success shape is:

```json
{
  "schemaVersion": "feedback-response/v1",
  "accepted": true,
  "contributionId": "c-example",
  "version": 1
}
```

Accepting feedback does not itself change reliability, trust status or earnings. Phase 5 defines
trust effects; Phase 6 defines eligible paid-use earnings. The request/response envelopes above
are proposals, not existing types or persisted records.

## Errors

Every error uses the same machine-readable envelope. Optional `details` contains only safe,
operation-specific validation information; do not include arbitrary exception text.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The request is invalid.",
    "details": {
      "issues": [
        {
          "path": "filters.sideEffect",
          "code": "invalid_value",
          "message": "has an invalid value"
        }
      ]
    }
  }
}
```

Proposed stable HTTP mapping:

| HTTP | Stable code(s) | Use |
|---|---|---|
| 400 | `invalid_request`, `invalid_search_request`, `invalid_expected_version`, `invalid_budget` | Malformed request, search issues, invalid expected version, or non-positive/non-safe UTF-8 budget. |
| 401 | `unauthorized` | Missing/invalid/expired/revoked credential or inactive agent/operator; same public response for all. |
| 403 | `contribution_not_allowed`, `feedback_not_eligible` | Authenticated but not allowed to submit, or not eligible to report this exact retrieved version. |
| 404 | `not_found` | Unknown contribution/version or `operator_mismatch`; do not distinguish absence from inaccessible-resource existence. |
| 409 | `duplicate_content`, `version_conflict` | Duplicate submission or optimistic version conflict. `latestVersion` may be returned only after the registry confirms the caller is the original operator. |
| 413 | `budget_too_small`, `response_too_large` | Budget cannot fit the empty discovery envelope or complete retrieval response. |
| 422 | `invalid_content`, `platform_field_rejected`, `unresolved_reference`, `family_mismatch`, `invalid_feedback` | Valid JSON that fails contribution or (once defined) feedback validation. |
| 429 | `rate_limited` | Per-agent or per-operator limit; include `Retry-After` when known. |
| 500 | `content_unavailable`, `internal_error` | Retrieval integrity/storage failure or unexpected internal failure; no storage diagnostic is returned. |
| 503 | `rate_limiter_unavailable` | Shared rate-limit enforcement cannot safely determine whether to admit the request. |

Never return credential verification sub-reasons, tokens, stack traces, SQL/R2 details, object keys,
raw stored content, or whether a particular D1/R2 integrity check failed. Map both missing and
corrupt/inconsistent stored content to `content_unavailable`. Map contribution and version
absence to the same `not_found` response. Do not return another operator's duplicate contribution
ID; omit duplicate identity details from the public error.

## UTF-8 budgets and conditional retrieval

The existing internal helpers count UTF-8 bytes of `JSON.stringify` output, not characters and not
model tokens. Search returns the largest ranked prefix that fits, preserving order and reporting
`omittedResultCount`. Retrieval returns the complete result or `response_too_large`; it never
truncates content or Knowledge `untrustedExplanation`. Invalid budgets are rejected. The REST
contract requires `maxUtf8Bytes` on search and get; platform maximums and admission limits must be
chosen before deployment.

Conditional get uses the exact `{contributionId, version, contentHash}` validator. It must perform
the normal full D1/R2 integrity verification before comparison. A match avoids retransmitting the
contribution body by returning `retrieval-not-modified/v1`; it is not a cache hit, does not bypass
verification, and does not change mutable platform state semantics. This is separate from the
deferred shared persistent cache decision.

## Phase 4 acceptance traceability

| Phase 4 acceptance criterion | Planned route/control | Current status |
|---|---|---|
| An external agent can discover and invoke Commons functionality. | Versioned JSON REST routes; later REST/MCP discovery documentation. | Not met: no public endpoint or external access. |
| All four operations work through defined interfaces, with family-aware search, retrieval, contribution and feedback. | `search`, `get`, `contribute`, `feedback`; Knowledge/Execution behavior above. | Not met: domain services exist for search/get/contribute; no routes, and feedback service/schema is absent. |
| Errors return actionable machine-readable information. | Shared error envelope and status/code table. | Contract documented; no HTTP error mapper exists. |
| The agent does not require a graphical interface. | JSON REST operations; future MCP adapter shares domain semantics. | Design is headless; no external interface is implemented. |
| Requests are authenticated and rate-limited per agent and per operator. | Bearer credential verification plus REST auth/rate-limit middleware. | Credential verification exists; middleware, thresholds and shared limiter storage do not. |
| Contributions from non-allow-listed operators are refused. | `contribute` passes authenticated identity to `ContributionRegistry`. | Internal allow-list check exists; no REST route. |
| Feedback from agents that never retrieved the content is refused. | Exact-version retrieval receipt checked by `feedback`. | Not met: no receipt persistence, feedback storage or endpoint exists. |

## Headless integration examples

The examples show the proposed request flow; `$BASE_URL` and `$AGENT_TOKEN` are client-side
configuration, not repository or deployment settings. The Knowledge query uses its family filter.
For an Execution recipe, search first and then retrieve the exact ID and version returned by the
discovery result:

```sh
curl -sS "$BASE_URL/v1/commons/search" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"httpbin get response fields","family":"knowledge","maxUtf8Bytes":16000}'

curl -sS "$BASE_URL/v1/commons/search" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"check httpbin response","family":"execution","maxUtf8Bytes":16000}'

curl -sS "$BASE_URL/v1/commons/get" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contributionId":"<execution id from search>","version":1,"maxUtf8Bytes":64000}'
```

Clients must treat Knowledge `untrustedExplanation` as untrusted data and must not execute
Execution recipe steps merely because they were retrieved.

This task adds documentation only. It does **not** implement endpoints, middleware, persistence,
migrations, bindings, deployment settings, or external-agent access.
