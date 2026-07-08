# Architecture Decision Records

ADRs capture significant architectural decisions: the context, the decision itself, and its consequences. They are immutable once accepted — a change of course gets a **new** ADR that supersedes the old one.

## Conventions

- Files are named `NNNN-kebab-case-title.md` — four digits, zero-padded, monotonically increasing, never reused.
- Statuses: `Proposed` → `Accepted`, and later possibly `Deprecated` or `Superseded by NNNN`.
- To write one: copy [the template](./template), take the next number, then add it to the table below **and** to the sidebar in `docs/.vitepress/config.mts`.

## Log

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](./0001-record-architecture-decisions) | Record Architecture Decisions | Accepted | 2026-07-08 |
