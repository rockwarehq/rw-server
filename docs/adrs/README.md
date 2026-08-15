# Architecture Decision Records

ADRs capture significant architectural decisions: the context, the decision itself, and its consequences.

They are immutable once accepted — a change of course gets a **new** ADR that supersedes the old one.

## Conventions

- Pages live at `docs/adrs/NNNN-kebab-case-title.md` — four digits, zero-padded, monotonically increasing, never reused.
- Statuses: `Proposed` → `Accepted`, and later possibly `Deprecated` or `Superseded by NNNN`.
- To write one: copy [the template](./template.md), take the next number, then add it to the table below.

## Log

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](./0001-record-architecture-decisions.md) | Record Architecture Decisions | Accepted | 2026-07-08 |
| [0002](./0002-database-access-boundary.md) | Database Access Boundary for the API App | Accepted | 2026-07-08 |
| [0003](./0003-service-error-contract.md) | Service Error Contract and Transport Mapping | Accepted | 2026-07-08 |
| [0004](./0004-app-owned-composition-roots.md) | App-Owned Composition Roots | Accepted | 2026-07-08 |
| [0005](./0005-station-status-running-slow-down.md) | Station Status: Running, Slow, and Down | Accepted | 2026-07-10 |
| [0006](./0006-metric-bucket-field-definitions.md) | Metric Bucket Fields and OEE Calculation | Accepted | 2026-07-10 |
| [0007](./0007-mes-history-correctness-defaults.md) | MES History Correctness Defaults | Accepted | 2026-07-12 |
| [0008](./0008-historian-series-queries.md) | Historian Series Queries | Proposed | 2026-07-13 |
| [0009](./0009-outbound-integrations.md) | Outbound Integrations and Hook Trigger Binding | Accepted | 2026-08-03 |
