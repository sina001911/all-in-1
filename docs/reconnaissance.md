# Media Provider Reconnaissance (P1, READ-ONLY)

> Status: **reconnaissance only.** No provider has been enabled, purchased,
> installed, authenticated, or used. No API key has been requested, displayed,
> stored, or logged. Web search was unavailable during this pass, so **no
> capability or pricing claim below is verified**.

## Purpose

Record candidate providers and the criteria PM1 must apply, so that when a
provider is evaluated it is done against a fixed, auditable checklist.

## Selection criteria (to be satisfied before any provider is registered)

1. Has a documented **free** tier (pricing verified from provider metadata,
   not assumed). Unknown pricing is treated as premium and blocked.
2. No payment instrument required to reach the free tier.
3. Reachable over HTTPS from the standard endpoint; no known 403 region issue
   (the OpenRouter EU endpoint is a precedent — always record endpoint issues).
4. Authenticates via an environment-variable-resolved key, never an inline
   secret.
5. Capabilities are recorded **only from verified provider metadata**. Nothing
   is invented.

## Candidate observations

> All entries are **UNVERIFIED** and recorded as candidates only. Capabilities
> and pricing are intentionally omitted because they have not been confirmed
> from provider metadata in this pass.

| Candidate | Status | Notes |
|---|---|---|
| *(none verified)* | UNVERIFIED | No provider metadata was inspected in P1 |

Web search returned no results in this environment, so the candidate list is
deliberately empty rather than speculative. Filling it is a PM1 task.

## What PM1 must do

1. Inspect each candidate's published model metadata (capabilities, input/output
   types, resolution, duration limits).
2. Confirm pricing from the provider's own rate table; record `free` only when
   confirmed, else `unknown`.
3. Record endpoint issues (e.g. regional 403s) in `knownEndpointIssues`.
4. Register into `MediaProviderRegistry` with `apiKeyEnv` set to an env NAME.
5. Gate everything behind `media.enabled`, which stays `false` until the
   provider is verified and explicitly approved by the user.

## Hard constraints on reconnaissance

- Never enable a provider.
- Never purchase or subscribe.
- Never install provider software.
- Never authenticate or use a paid endpoint.
- Never request, display, store, or log an API key.
