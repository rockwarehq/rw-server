# How to Write Docs

The docs site is plain markdown rendered by [VitePress](https://vitepress.dev). Everything lives under `docs/` at the repo root.

## Running the site

```sh
pnpm docs:dev      # dev server at http://localhost:5173
pnpm docs:build    # production build (also fails on dead links — run before pushing)
pnpm docs:preview  # serve the production build
```

## Adding a page

1. Pick the right section:
   - `docs/guides/` — how-tos and workflows
   - `docs/architecture/` — one page per implemented pattern
   - `docs/adrs/` — decision records (see below)
2. Create the `.md` file.
3. Register it in the sidebar in `docs/.vitepress/config.mts` (the sidebar is maintained by hand).

## Markdown extras

- **Mermaid diagrams**: use a fenced code block with the `mermaid` language tag — it renders as a diagram in the browser.

  ````md
  ```mermaid
  sequenceDiagram
    api->>redis: publish event
    workers->>redis: subscribe
  ```
  ````

- Internal links are relative markdown links (`[text](./other-page)`); the build fails on dead links, which keeps them honest.
- All standard VitePress markdown features work: [containers](https://vitepress.dev/guide/markdown#custom-containers) (`::: tip`), code groups, line highlighting, etc.

## Writing an ADR

1. Copy `docs/adrs/template.md` to `docs/adrs/NNNN-kebab-case-title.md` using the next free number.
2. Fill it in; open a PR with status `Proposed`.
3. When agreed, flip the status to `Accepted`.
4. Add a row to the log table in `docs/adrs/index.md` and a sidebar entry in `docs/.vitepress/config.mts`.
