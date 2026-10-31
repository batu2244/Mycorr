# Mycorr: First Draft Build Brief

This README is an implementation brief for Claude. The project is named Mycorr. Build the first working version of Mycorr as this brief describes it. This document describes intended behavior. It does not claim that an application or any integration exists.

## 1. What we are building

Mycorr is a personal agent which can be used for planning/collaborating with other people. For example, lets take the example of planning trip with friends and family. Each person first chats privately with a question agent. The system saves every answer and builds a structured profile. When the required information is complete, a personal agent represents that person in a discussion with the agents of their friends. The group discussion runs without more messages from the people. Save the conversation. Return it through a simple API and a plain-text export.

Use these three services:

- **Superserve:** runs the question agents and the personal agents in VMs.
- **TerseAI Durable Actors:** stores onboarding history, profiles, trip state, tasks, and captured planning conversations. Terse calls its implementation Durable Actors. Do not substitute Cloudflare Durable Objects.
- **Agent Relay:** carries messages between the personal agents.

Our backend and coordinator connect these services. Two definitions apply in this brief. An actor is a persistent software object. An AI agent is a model-driven process that runs in a VM.

## 2. First draft scope

Build one complete flow:

1. The creator creates a trip. The creator sets the city and the date range, and selects the participants. The city and the date range are fixed for the trip. Participants do not negotiate them.
2. Each participant completes private conversational onboarding. The question agent does not ask for the city or the trip dates. It asks for availability inside the trip date range.
3. Store the original questions and answers. Extract the structured profile.
4. Start a planning run automatically when all selected participants are ready.
5. Personal agents exchange proposals through Agent Relay.
6. Stop after a bounded discussion. Save a draft itinerary or the unresolved conflicts.
7. Return the full agent conversation and the result through an API and a plain-text export.

Use two participants for the smallest demo. Support participant lists of any size. Demonstrate five participants before you call the MVP complete. Do not hard-code a two-person workflow.

The required delivery is a **JSON API and a plain-text transcript**. An outbound webhook is optional after the core flow works. SMS, email delivery, and messaging-app integrations are outside this draft.

These items are also out of scope: bookings, payments, production deployment, a full social network, complex authentication-provider integration, live travel search, and an elaborate UI. Label venue suggestions and costs as "unverified estimates" unless an implemented live source supplies them.

## 3. Implementation approach

- Use TypeScript throughout. Use one repository.
- Prefer a small Next.js frontend and backend, a separate long-running coordinator worker, and Terse's local development runtime. Use a different thin HTTP framework only if the existing repository makes that simpler.
- Use Zod, or an equivalent runtime validator, to validate profiles, events, API inputs, and model outputs.
- Implement one model-provider integration behind an adapter. Choose the available provider. Make the model configurable.
- Use a package manager and runtime that the pinned Durable Actors release supports. Commit a lockfile.
- Keep the coordinator outside the VMs that it pauses, so that it can resume them.
- Do not run long planning jobs inside an HTTP request. Do not hold a trip actor call open while a model runs.
- Use actor-backed pending tasks for this draft. Do not add a queue broker, Redis, or a vector database unless the selected runtime itself requires one.

Suggested organization. These paths are proposals, not existing files:

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Minimal UI and backend API |
| `apps/worker/` | Coordinator, Relay recorder, retries, VM lifecycle |
| `packages/actors/` | UserActor, TripActor, generated actor clients |
| `packages/agents/` | VM agent runner, question and personal roles |
| `packages/contracts/` | Profile requirements, validated DTOs, event types |
| `packages/integrations/` | Superserve, Relay, and model-provider adapters |
| `tests/` | Focused behavior and integration tests |

Keep this structure light. Define each shared contract once.

## 4. Architecture

```mermaid
flowchart TD
    UI["User chat and trip view"] <--> API["Backend API"]
    API <--> U["UserActor: answers and profiles"]
    API <--> T["TripActor: runs and transcripts"]
    W["Coordinator and recorder"] <-->|"Durable tasks and results"| U
    W <-->|"Durable tasks and results"| T
    W -->|"Start or resume"| V["Superserve: question and personal agents"]
    V -->|"Scoped tools"| API
    V <-->|"Personal-agent messages"| R["Agent Relay"]
    R -->|"Messages and history"| W
```

During development, run the web/API, the coordinator, and the actor runtime locally. Run real agent sessions in Superserve and connect them to Relay. A VM cannot reach the laptop's `localhost`. Use a Superserve preview URL as the backend URL that the VMs can reach. Section 11 describes the setup. Keep the actor runtime credentials and the provider administration credentials behind the backend.

## 5. Configurable profile requirements

The complete field list is not final. Define the required fields in one versioned schema. Do not scatter them through prompts or UI code.

| Field | Initial representation | Completion rule |
| --- | --- | --- |
| Availability | Date/time windows with timezone, inside the trip date range that the creator set | Concrete usable windows inside the trip date range, or an explicit answer that the whole range works |
| Flexibility | What may change (schedule, spending, activities) and any stated limits | A clear split between negotiable constraints and fixed constraints |
| Daily budget | Per-person amount in integer minor units, currency, expense scope, firm or flexible | An explicit amount and scope, or an explicit no-limit answer |
| Total budget | Per-person trip amount, currency, expense scope, firm or flexible | Same rule as daily budget |
| Preferences | Extensible interests, dislikes, and any stated priorities | Explicit interests/dislikes, or an explicit no-preference answer |

Seed the preference categories with food, nature, museums, restaurants, and bars. Allow other categories. Do not require a separate question for every category.

For each field, record its value, its status (`missing`, `answered`, `needs_clarification`), and the IDs of the answers that support it. Keep provenance for derived values. A missing value is different from zero, from no preference, and from no limit. Do not guess budget scope, currency, timezone, or flexibility.

Store general interests as reusable profile data. Store availability, budgets, and trip-specific overrides under `tripId`. Support trips that span several days inside the trip date range. Handle daily limits and total limits independently. A three-day trip does not mean that the user must spend every daily budget in full.

Version both the profile schema and the profile contents. When you add a required field, the completeness check must request that field without erasing existing answers. Keep each historical planning run tied to its original schema version and profile versions.

## 6. Durable data ownership

### UserActor(userId)

Owns the person's private information:

- General profile and profile version.
- Per-trip requirements and overrides.
- Per-trip onboarding sessions, their status, and their missing fields.
- Append-only onboarding messages. Each message has an ID, a client message ID, a role, text, a timestamp, a sequence number, and a trip/session ID.
- Original user corrections, stored as new messages, plus the updated structured values that result from them.
- Pending question-agent tasks, their attempts, their input version, and their result status.
- VM/session identifiers and references to credentials. Do not embed provider secrets in public state.

### TripActor(tripId)

Owns shared planning information:

- Trip title, city, date range, creator ID, participant IDs, and trip version. The creator sets the city and the date range before onboarding starts.
- Readiness notifications and profile-version references.
- Pending planning tasks and durable run state.
- Run-specific participant roster, input snapshots, and schema/profile versions.
- Agent-to-agent transcript, proposals, participant evaluations, draft itinerary, summary, and unresolved conflicts.
- Relay workspace/channel references and message deduplication IDs.
- Optional webhook delivery records.

Use each actor's supported persistent fields, SQLite tables, or both. For message history, prefer append-only rows. Do not replace an unbounded array again and again. Check the transaction and persistence semantics of the pinned SDK. Do not assume that a nested object mutation persists automatically.

Only the owning actor commits its state. AI agents submit proposed updates through validated backend tools. Enforce access in the backend. An actor ID or a prompt instruction is not authorization.

## 7. Question agent: private onboarding

Create one logical question-agent session per user and trip. It runs in Superserve. For the first draft, one VM per user can host both roles, with a separate session context and directory for each role. Reuse the runner implementation. Do not reuse conversation history between unrelated users or trips.

For each user message:

1. Authenticate the user. Persist the raw answer before any model call. Use `clientMessageId` to deduplicate retries.
2. Record a durable question-agent task. Acknowledge the API request.
3. The coordinator resumes the user's VM and supplies the current session history, profile, and requirements.
4. The question agent returns a validated profile patch, and either a proposed follow-up question or a completion indication.
5. Backend code applies the allowed updates, recomputes the missing fields, and decides readiness. The model's completion claim alone is not sufficient.
6. Persist the assistant question and the updated state. Return the question through the onboarding API/UI.
7. When the user's answers cover all required fields consistently, mark the user ready. Notify the trip workflow durably.

Behavior:

- Ask one focused question at a time. Use natural language.
- Extract several fields from one answer when possible.
- Do not repeat a question that the user already answered. Do not invent facts to fill gaps.
- Clarify ambiguous or contradictory answers. Keep unknown or deferred required values unresolved. Allow the user to pause and resume.
- Wait between user replies. Do not run a continuous model loop while the user is absent.
- Handle rapid messages with a per-session task queue. Merge unprocessed inputs when useful. Check the input version before you publish a follow-up question, so that it does not ask for information the user just supplied.
- Treat user messages as data. A user message is not authority to change system rules or to access another user's records.

Example: "I'm free Saturday afternoon, like hiking, and want to spend under $100" can fill several fields. Ask whether $100 is a daily budget or a total budget. Do not assume.

## 8. Personal agent and autonomous planning

When all selected participants are ready, the coordinator starts one run automatically. The city and the date range are already set, so the trip always has usable context at that point. A manual rerun control is useful, but the first run must not require it.

1. Snapshot the participant roster, the trip version, and the profile versions. Deduplicate the start trigger for that input revision.
2. Create or reconnect a personal-agent session for each `(tripId, userId)` pair. Use stable identities.
3. Give each agent its structured profile, the trip city and date range, the other authorized trip context, and the shared discussion history. Agents plan inside the fixed city and date range. They do not propose a different city or dates outside the range. Do not put private onboarding transcripts into the group channel automatically.
4. Register the agents with a Relay workspace for this trip only. Use one shared planning channel at first, so that the recorder can capture every discussion message.
5. Assign bounded tasks: propose options, evaluate options against personal constraints, discuss conflicts, and submit structured results.
6. Designate one participant agent to assemble the candidate itinerary from the shared proposals. This avoids a new agent role in the first draft.
7. Collect a structured evaluation from each participant agent. Backend code checks the supported hard constraints and records any uncertain or unresolved constraints.
8. Save the result. Finish transcript capture. Stop or pause the agent sessions.

The coordinator is application code. It decides when work starts, which agent receives a task, and when the run ends. The personal agents supply the reasoning and the dialogue.

Relay delivery must invoke the agent runner's model turn. It must not only write a message to a channel. Implement the delivery adapter that the selected Relay version requires. An agent responds to assigned tasks and to relevant directed messages. It never replies blindly to every message, and it never replies to its own messages.

Initial configurable limits: three discussion rounds, a five-minute run deadline, and an explicit per-run budget for model calls and tokens. End early when a validated draft is available. If the agents do not agree, return alternatives and conflicts. A missing agent response is not agreement.

Agent agreement produces a **draft**. It is not user approval, and it is not permission to book anything. Agents cannot relax a user's hard constraints without an explicit authorized profile update.

Suggested run states: `queued`, `running`, `completed`, `needs_input`, `failed`, `cancelled`, `stale`. Keep missing-response details and failure details with the partial results.

## 9. Capture and deliver the conversation

Implement a recorder in the coordinator process. Subscribe to the message events of the pinned Relay SDK. Use history retrieval to recover gaps after a reconnect. Deduplicate with the Relay message ID. Link every channel, thread, and message to the correct trip and run.

Store these transcript fields:

```ts
type TranscriptMessage = {
  id: string;
  relayMessageId: string;
  tripId: string;
  runId: string;
  sequence: number; // Assigned by our recorder; capture order.
  senderAgentId: string;
  representedUserId?: string;
  channelId: string;
  replyToMessageId?: string;
  sentAt: string;
  recordedAt: string;
  text: string;
};
```

Sequence is capture order. It is not proof of causality across machines. Keep reply references. In the first version, route all planning discussion through the shared channel. Do not add private agent DMs that the recorder cannot capture.

Keep the full exchanged conversation, the structured proposals, and the final summary separately. A summary is not a substitute for the transcript. Before you mark capture complete, reconcile the recorded messages against the Relay history. If capture is incomplete, expose that status and continue recovery.

### Proposed application API

We implement these endpoints. They are not provider SDK methods. Identity comes from an authenticated server session or a scoped agent token. A caller-supplied `userId` alone is not identity.

| Method and path | Behavior |
| --- | --- |
| `POST /api/trips` | Create a trip with a city, a date range, optional context, and participant IDs. Reject a request without a city or a date range |
| `GET /api/trips/:tripId` | Return authorized shared state and participant readiness |
| `POST /api/trips/:tripId/onboarding/messages` | Accept `{ clientMessageId, text }`. Persist the input. Return `202` with the message ID and the task ID |
| `GET /api/trips/:tripId/onboarding` | Return the calling user's questions, answers, profile, missing fields, and processing status |
| `POST /api/trips/:tripId/runs` | Optional manual retry or rerun. Check readiness. Prevent duplicate active runs |
| `GET /api/trips/:tripId/runs/:runId` | Return status, capture status, transcript, summary, itinerary, and conflicts |
| `GET /api/trips/:tripId/runs/:runId/transcript?format=txt` | Return the readable conversation with `Content-Type: text/plain; charset=utf-8` |

Add scoped internal tools so that agents can read their context and submit validated profile patches, questions, proposals, or evaluations. Do not expose raw actor access to a VM or a browser.

Use polling for the first UI if polling is simplest. WebSocket or SSE streaming can come later. The result API must work without the UI.

### Optional webhook

Support a server-configured destination only after the API and the text export work. Persist each outgoing delivery before you send it. Send a stable event ID, the trip ID, the run ID, the terminal status, and the summary. Also send an authenticated URL for the result and the transcript. Reuse the event ID on retries. Document at-least-once delivery. Sign each request with a configured secret. Export only shared planning content. Do not export private onboarding answers.

Do not assume a recipient, a destination URL, or an SMS provider. An unconfigured webhook must not block retrieval of a completed run through the API.

## 10. Reliability and access boundaries

- Multiple users onboard independently. Serialize state changes inside each actor. Avoid long network calls and model calls in actor methods.
- Persist pending work before you dispatch it. Use `taskId` and `runId`, attempt counters, and a claim or lease, so that a restarted worker can recover tasks without applying duplicate results.
- Profile updates and trip notifications span actors. Persist the notification together with the profile update, with the supported atomic mechanism. Retry delivery. Make the trip-side handler idempotent.
- Pass the expected input versions with results. Reject or recompute stale question updates and profile updates. If a participant changes relevant information during planning, mark the run stale and schedule a bounded replacement run. Do not publish an outdated draft as current.
- Reconcile input versions before you publish the final result. Treat a new participant as a new trip revision.
- Run only one active planning run per trip in the draft. Retry transient provider failures with bounded backoff. Expose terminal errors.
- Store persistent data in Durable Actors, so that it survives a local runtime restart. VM files are working context. They are not the authoritative profile store.
- Keep provider keys on trusted server and runtime surfaces. Give each VM scoped access to its own user, trip, and task only. Keep workspace administration credentials out of model prompts and browser bundles.
- Seeded demo identities are acceptable for local testing. Use separate server-side sessions to enforce identity and membership. Label demo identity selection as development-only.

## 11. Local setup and integration modes

Before you write provider calls, read the current official documentation and choose compatible versions:

- [Superserve](https://www.superserve.ai/)
- [Superserve source and documentation](https://github.com/superserve-ai/superserve)
- [TerseAI Durable Actors](https://github.com/TerseAI/durable-actors)
- [Durable Actors TypeScript guide](https://github.com/TerseAI/durable-actors/blob/main/docs/reference/typescript-guide.md)
- [Agent Relay](https://agentrelay.com/)
- [Agent Relay SDK source](https://github.com/AgentWorkforce/relay/blob/main/packages/sdk/README.md)

During architecture research on 2026-10-31, the public Relay SDK URL redirected to a versioned v7.1.1 page. The main-branch SDK README described a different API. Check again before implementation. Pin a compatible release or commit. Do not mix examples from different versions. Pin Terse's runtime and the generated client together as appropriate. Do not invent SDK methods from the conceptual API in this brief.

Implement a thin adapter for each provider. Document exactly which calls you checked against the real service.

Provide two explicit modes:

- **Integrated mode:** real Durable Actors persistence, Superserve VMs, Relay messaging, and model calls. Both the question role and the personal role must run in Superserve.
- **Mock mode:** clearly labeled deterministic adapters for external services that are not available. This mode lets the basic workflow and the failure handling run without credentials. Prefer the real local actor runtime for persistence in this mode too.

Never switch to mock mode silently. A passing mock demo does not show that the external integrations work. If credentials are missing, do three things. Complete the code and the mock checks. Document exactly what remains unchecked. Give the steps to finish the real integration.

Create a `.env.example` with the actual variables that the selected SDKs require. Include these settings:

- actor connection settings
- Superserve credentials
- model credentials and model choice
- server-side Relay bootstrap configuration
- `PUBLIC_BACKEND_URL`: the Superserve preview URL that VMs can reach
- `SUPERSERVE_SANDBOX_ID` and `SUPERSERVE_PREVIEW_TOKEN` for the published backend port
- agent-service authentication
- mode selection
- optional webhook settings

Persist per-trip workspace references separately. Never commit real secrets.

The implementation must provide and document commands for these tasks:

- Install dependencies.
- Start the actor runtime.
- Generate clients.
- Start the web/API process and the worker process.
- Run tests.
- Seed two or five demo users.
- Run a smoke test.

Add runnable scripts. Do not present proposed commands as commands that already work.

### Public backend URL through Superserve

Agent VMs run in Superserve. They cannot reach `localhost` on a laptop. Superserve preview URLs solve this. A preview URL publishes one port of a sandbox at this address:

```
https://{port}-{sandbox-id}.sandbox.superserve.ai
```

For development, run the backend inside a Superserve sandbox. Publish the API port. Give the agents that URL as `PUBLIC_BACKEND_URL`.

These commands use CLI version 2.1.1. We checked them against the CLI help and docs.superserve.ai on 2026-10-31. Replace `<id>` with the `id` field from the create command. Do not use the name, because names are not unique.

```bash
npm install -g @superserve/cli
superserve login --no-wait --json
# The command prints a URL and a code. Open the URL, confirm the code, and click Authorize.
# Then run the same login command again. It prints "logged_in": true.

superserve sandbox create --name mycorr-backend --json
superserve cp . <id>:/home/user/mycorr
superserve exec <id> "cd /home/user/mycorr && npm install && nohup npm run dev >/tmp/web.log 2>&1 &"

superserve preview publish <id> 3000 --private
superserve preview url <id> 3000
superserve preview token <id> 3000
```

Rules for the preview URL:

- Publish the API port as private. A private port requires a token. Agents send the token in the request header. Browsers open a signed URL from `superserve preview url <id> 3000 --signed --expires 1h`.
- Use `--public` only for a short demo. A public port is reachable from the internet without a credential.
- Store the sandbox ID and the token in `.env`. Never commit them. Run `superserve preview rotate <id> 3000` if a token leaks.
- The same calls exist in the TypeScript SDK: `publishPreviewPort`, `getPreviewUrl`, `getPreviewToken`, `getSignedPreviewUrl`, `rotatePreviewToken`, and `unpublishPreviewPort`.
- A preview URL is a development convenience. It is not production deployment, which stays out of scope.

Status on 2026-10-31: the CLI install and the login command ran. Sandbox creation and port publishing wait for browser authorization of the login. The commands above are not yet proven end to end.

## 12. Build order

1. **Contracts and state:** profile schema, completeness rules, actor data model, IDs, version handling, and persistent read/write paths.
2. **Onboarding:** raw-answer persistence, async tasks, question-agent runner, structured extraction, follow-up questions, and readiness checks.
3. **One real VM:** show that the question role can run in Superserve and use scoped backend tools through the development URL.
4. **Personal-agent delivery:** connect two agents through Relay. Show that a received task triggers the receiving runtime.
5. **Autonomous run:** all-ready trigger, durable coordinator tasks, bounded proposal and review rounds, and result validation.
6. **Capture and export:** recorder, history recovery, full transcript API, plain-text export, and summary and result output.
7. **Demo and checks:** minimal UI, two-person and five-person demos, focused failure tests, and setup documentation that matches the code.
8. **Optional:** webhook, after all required acceptance checks pass.

## 13. Acceptance checks

Write meaningful tests for these behaviors. Add a real-provider smoke test when credentials are available:

- Two users can answer at the same time without seeing or overwriting each other's private information.
- Every question, original answer, and later correction remains available after a restart.
- One answer can fill several fields. An ambiguous budget scope causes a clarification question, not an invented value.
- Schema rules compute readiness. Malformed model output cannot mark a user ready.
- Adding a required field keeps history and requests only the missing information.
- Fast successive user messages do not publish an obsolete follow-up question and do not overwrite newer values.
- When the final participant becomes ready, one run starts automatically without another user prompt. Duplicate notifications do not start duplicate runs.
- In integrated mode, both agent roles run in Superserve. Personal-agent messages travel through Relay and reach the receiving runner.
- A five-person run respects participant boundaries and stops within the configured limits, including when an agent fails or cannot agree.
- A preference change during a run prevents an outdated result from becoming the current draft.
- A worker or VM disconnect followed by a retry does not duplicate stored transcript entries or applied results. The API reports partial capture until recovery completes.
- The JSON endpoint and the text endpoint return the actual saved conversation. They expose the summary, the itinerary, the conflicts, and the capture status separately.
- Private onboarding history and provider secrets do not appear in another user's API response or in the shared transcript.
- If you implement the webhook, a webhook failure does not lose the result and does not block API access. A retry keeps the event ID.

## 14. Instructions to Claude

First, inspect any existing repository and its instructions. Implement this brief with small, conventional choices. Keep the agreed technologies and the user flow. Do not expand the product scope to resolve a minor uncertainty. Document reasonable assumptions instead.

Finish with source code, a dependency lockfile, a `.env.example`, runnable scripts, demo fixtures, focused tests, and updated setup instructions. Add example API requests. Show how to retrieve a saved transcript. Report clearly which checks ran in mock mode, which ran against real services, and which external configuration remains.

The first useful deliverable is a working flow from onboarding to agent discussion, with persistent state and a retrievable conversation. Visual polish and optional delivery channels come after that.
