# @rw/integrations

Outbound integrations: a configured external target (SQL Server, REST API, webhook) plus the
actions that can be run against it. Modelled on Activepieces' piece/connection split.

## Three layers, kept separate

| Layer | Lives | Owned by |
| --- | --- | --- |
| **Integration** — credentials + endpoint | `Integration` DB row | this package's schemas |
| **Action** — capability contract | code, in this package | this package |
| **Binding** — where input values come from | the consumer | livestore hooks, automations, … |

The binding layer is deliberately outside this package. A livestore hook binds action inputs to
graph property ids; nothing here knows what a graph property is. That is what lets a second
consumer reuse the same integration without inheriting hook concepts — and it keeps hooks
terminal event emitters, per `packages/livestore/spec.md` §4.8.

## Config vs secret

Each type declares two schemas:

- `configSchema` — plaintext. Host, port, base URL, username. Readable by the console, safe to log.
- `secretSchema` — encrypted at rest. Every field is a secret by definition, so the console renders
  password inputs and the service layer redacts without a per-field allowlist.

`validate(config, secret)` covers cross-field rules a single schema can't express — see `rest.ts`,
where the secret's shape is a discriminated union over `config.authType`.

## Secrets are encrypted, not hashed

We hand the plaintext password to SQL Server, so this is the codebase's first **reversible** secret
path. `@rw/auth`'s `secrets.ts` (SHA-256) and `password.ts` (bcrypt) are one-way and cannot be used
here.

`crypto.ts` seals with AES-256-GCM: `[version:1][iv:12][tag:16][ciphertext]`, with the integration's
id bound in as AAD so a ciphertext copied onto another row fails to open.

**Operational requirements:**

- `INTEGRATION_ENCRYPTION_KEY` — 64 hex chars. `generateEncryptionKey()` mints one.
- **Back the key up with the database.** Lose it and every stored credential is unrecoverable.
  In a local install it belongs in `rw-local-provisioner`'s `state.json`, whose mint-once semantics
  already guarantee it survives re-runs.
- The key must never live in Postgres. Ciphertext and key sharing a blast radius defeats the point.
- `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` is read during rotation so already-sealed secrets stay
  readable until they are re-sealed.

## Execution

Everything runs in rw-server, in-process via `executeAction` — same place `imm.cycle_completed` is
consumed. For on-prem customers the whole stack is provisioned onto the plant network, so a plant
SQL Server is directly reachable and no gateway hop is needed.

`ExecutionLocation` still has an `"edge"` value for a type that would have to be dispatched to a
gateway. Nothing uses it today; a type that declares it without providing `run` gets
`EDGE_EXECUTION_REQUIRED` rather than an obscure crash.

SQL Server connections are pooled per integration id and rebuilt when the connection details change,
so editing a password doesn't leave the old pool serving traffic. Call `closeSqlServerPools()` on
shutdown, and `closeSqlServerPools(id)` after deleting an integration.

## Adding a type

Add a file exporting an `IntegrationType`, register it in `createDefaultIntegrationRegistry()`.
Because `buildIntegrationCatalog()` serializes the zod schemas to JSON Schema, the console renders
the new type's forms with no UI change.

## Consolidation intent

This is currently the fourth action registry in the repo. It is meant to absorb the other two:

- `packages/services/src/facility/station/actions/` — `webhook.send`, `alert.create`, …
- `apps/api/src/automations/actions/` — `sendAlert`

Neither should gain new actions.
