# How to Write Docs

Docs in this repo live in `docs/`. They are plain markdown for developers
working in the repo: guides, architecture patterns, ADRs, working notes.

- `docs/guides/` — internal how-tos and workflows
- `docs/architecture/` — one page per implemented pattern, plus standalone
  design docs (livestore spec, graph API, metrics pipeline)
- `docs/adrs/` — decision records (see below)
- `docs/notes/` — ephemeral working notes; delete when the work closes

Plain GitHub-flavored markdown, relative links between files. Start each page
with a single `#` title. Mermaid fenced code blocks render on GitHub.

### Writing an ADR

1. Copy `docs/adrs/template.md` to `docs/adrs/NNNN-kebab-case-title.md` using
   the next free number.
2. Fill it in; open a PR with status `Proposed`.
3. When agreed, flip the status to `Accepted`.
4. Add a row to the log table in the [ADR log](./adrs/README.md).

