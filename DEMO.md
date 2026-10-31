# Mycorr demo (mock mode)

What runs: real local Durable Actors persistence, the Hono API, a minimal web page, and an
**in-process demo coordinator** (`apps/api/src/demo-coordinator.ts`) that drives the question
agent, readiness, the planning run, the Relay recorder and the result. External services are
**mock adapters** (deterministic rule-based model, in-memory Relay). This proves the workflow and
persistence, not the Superserve/Relay/OpenAI integrations (see "Status" below).

## Run it

```bash
npm install -g bun            # Bun 1.4.2+ is required by durable-actors
bun install
bun run actors:dev            # terminal 1: local actor runtime on http://127.0.0.1:7100
bun run actors:generate       # once, or after changing packages/actors/src/actors.ts
cp .env.example .env && edit    # set MODEL_PROVIDER=openai + OPENAI_API_KEY for real agents, or MODEL_PROVIDER=mock
bun run api:dev               # terminal 2 (from repo root so .env loads): API + web page on http://127.0.0.1:3000
bun test tests                # 14 tests (contracts, actors on the real runtime, mock model)
bun run scripts/seed.ts 2     # or 5: creates a trip and prints ids + example answers
bun run scripts/smoke.ts 5    # end to end over HTTP: onboarding -> auto run -> transcript
```

Open http://127.0.0.1:3000. Identity is a **development-only** header (`x-mycorr-user`);
membership is still enforced per trip, so a non-participant gets 403 and each user sees only
their own onboarding.

## API examples

```bash
B=http://127.0.0.1:3000/api
curl -s -X POST $B/trips -H 'content-type: application/json' -H 'x-mycorr-user: ana' \
  -d '{"title":"Lisbon weekend","city":"Lisbon","timezone":"Europe/Lisbon","dateRange":{"start":"2026-11-20","end":"2026-11-22"},"participantIds":["ben"]}'
curl -s -X POST $B/trips/<tripId>/onboarding/messages -H 'content-type: application/json' -H 'x-mycorr-user: ana' \
  -d '{"clientMessageId":"a1","text":"Free the whole weekend, about €100 per day all-in, no total limit, love food and museums, no bars, totally flexible."}'
curl -s $B/trips/<tripId>/onboarding -H 'x-mycorr-user: ana'
curl -s $B/trips/<tripId>                              -H 'x-mycorr-user: ana'   # readiness + runIds
curl -s $B/trips/<tripId>/runs/<runId>                 -H 'x-mycorr-user: ana'   # run + transcript JSON
curl -s "$B/trips/<tripId>/runs/<runId>/transcript?format=txt" -H 'x-mycorr-user: ana'
curl -s -X POST $B/trips/<tripId>/runs                 -H 'x-mycorr-user: ana'   # manual rerun (409 if active/not ready)
```

## Status (honest)

Checked on 2026-10-31 with real OpenAI models (MODEL_PROVIDER=openai, planning gpt-5.4-mini, onboarding gpt-5.4): restaurant-only friendly onboarding asks one follow-up on a vague answer and completes on a specific one; readiness computed in code; a 2-person run completed in about 11 s with a concrete Lisbon itinerary, conflicts and constraint report exposed separately; JSON and text exports return the saved conversation. Mock mode (MODEL_PROVIDER=mock) still runs the 2- and 5-person flows deterministically.

Not checked against real services: Superserve VMs and Agent Relay (in-memory mock Relay is used; the separate apps/worker coordinator, agent runner package, real adapters and webhook are not built). Note: the Durable Actors dev server bundles packages/contracts at start; restart it after changing contracts.
