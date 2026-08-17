# How to Write Docs

Two doc trees, two audiences:

- **Internal docs** (this `docs/` directory) — plain markdown for developers
  working in the repo: guides, architecture patterns, ADRs, working notes.
- **Product docs site** (`apps/docs`) — a Next.js app (Tailwind Plus Protocol
  template, MDX pages) published for end users.

## Internal docs

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

## Product docs site

```sh
pnpm docs:dev      # dev server at http://localhost:30200
pnpm docs:build    # production build — run before pushing doc changes
pnpm docs:preview  # serve the production build
```

Pages are MDX under `apps/docs/src/app/` with a metadata export at the top:

```mdx
export const metadata = {
  title: 'Page Title',
  description: 'One-line description.',
}

# Page Title
```

Register new pages in `publicNavigation` in
`apps/docs/src/components/Navigation.tsx`.

MDX extras: mermaid fenced blocks render as diagrams; `h2` sections feed the
table of contents and search index; the template ships `<Note>`, `<Row>`/`<Col>`,
and `<CodeGroup>` components; literal `<` and `{` in prose must be escaped or
wrapped in backticks.
