# Mycorr: Follow-ups

These items come after the first draft in [README.md](README.md). Do not build them until the required acceptance checks in README §13 pass. Each item describes intended behavior. It does not claim that any code exists.

## 1. Export user profiles to Supabase

**Status:** proposed, not scheduled.

### Why

Durable Actors stay the source of truth. A Supabase copy can help with these needs:

- **Cross-user queries.** An actor holds the state of one user or one trip. Postgres can query across users, for example for analytics or for suggestions about whom to invite.
- **Data inspection during development.** The Supabase table view and SQL editor make it easier to check extracted profiles while we tune the question agent.
- **Profile reuse outside a trip.** Other features can read general interests through row-level security, without a call to the trip backend.
- **An off-runtime copy.** The copy can help if we wipe or migrate the local actor runtime. This reason is not sufficient alone.

Start this item only when one of these needs is concrete.

### Rules

- Data goes in one direction only: UserActor → Supabase. Planning, readiness, and runs never read from Supabase.
- When the UserActor commits a new profile version, it records an export task in the same atomic write. The coordinator worker does the upsert. Actor methods and agent VMs never call Supabase.
- Use the key `(user_id, profile_version)` for each export, so that retries are idempotent and an older version cannot overwrite a newer one.
- Export the structured fields, each field's status, the schema version, the profile version, and the IDs of the answers that support each field.
- Keep trip-scoped data (availability, budgets, overrides) in a separate table with the key `trip_id`.
- Do not export the raw onboarding messages unless a specific use requires them.
- Keep `SUPABASE_SERVICE_ROLE_KEY` in the worker only. Never put it in prompts, VMs, or browser bundles. Enable row-level security on every table.

### Draft schema

```sql
create table user_profiles (
  user_id text, profile_version int, schema_version int,
  preferences jsonb, flexibility jsonb, provenance jsonb,
  exported_at timestamptz default now(),
  primary key (user_id, profile_version)
);

create table trip_profile_overrides (
  user_id text, trip_id text, profile_version int,
  availability jsonb, daily_budget jsonb, total_budget jsonb,
  exported_at timestamptz default now(),
  primary key (user_id, trip_id, profile_version)
);

alter table user_profiles enable row level security;
alter table trip_profile_overrides enable row level security;
```

### Configuration

Add these variables to `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_EXPORT_ENABLED` (default `false`). An export that is not configured or that fails must not block onboarding or planning.

### Acceptance checks

- Duplicate export tasks for one profile version produce one row.
- An export of an older version that arrives late does not replace a newer row.
- A Supabase outage does not block readiness or runs. Export tasks retry with bounded backoff.
- Raw onboarding messages and provider secrets do not appear in Supabase.

### Separate decision: Supabase Auth

Supabase Auth could replace the seeded demo identities and supply the authenticated sessions that README §9 requires. That choice affects identity across the whole API. Decide it separately from this export.
