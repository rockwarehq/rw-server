# docs/

Repo-level documentation that doesn't belong to a single package.

- `architecture/` — standalone design docs and specs (livestore graph engine
  spec, graph HTTP API, metrics pipeline). The published documentation site
  (ADRs, guides, reference) lives separately in `apps/docs`.
- `notes/` — ephemeral working notes (audits, analyses). Delete a note when
  the work it tracks is closed.
- `postman/` — Postman collection + local environment for exercising the
  livestore graph API by hand.

Package-specific orientation stays in each package's own `README.md`.
