# 0001 – Record Architecture Decisions

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Michael Lindenau

## Context

Architectural decisions in rw-server have so far been made in PRs, chats, and per-package READMEs. The reasoning behind them is scattered or undocumented, which makes it hard for new contributors (and future us) to understand why things are the way they are — and hard to tell a deliberate decision from an accident.

## Decision

We will record significant architectural decisions as Architecture Decision Records in `docs/adrs/`, rendered by the internal VitePress docs site. Each ADR follows [the template](./template) and the numbering convention described in the [ADR log](./index).

A decision is "significant" when it is expensive to reverse or shapes how multiple packages/apps are built — e.g. choice of message broker, auth token design, worker process topology.

## Consequences

- The reasoning behind decisions survives beyond the PR that implemented them.
- Proposing a change of direction has a lightweight, standard format (a new ADR superseding an old one).
- Writing an ADR adds a small amount of friction to big decisions — intentionally.

## Alternatives Considered

- **Keep using per-package READMEs** — good for "how it works", bad for "why we chose this"; decisions spanning packages have no home.
- **A wiki/Notion** — drifts from the code, not reviewed in PRs, another tool to maintain access to.
