import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Rockware Dev Docs",
  description: "Internal developer documentation for rw-server",
  lang: "en-US",
  lastUpdated: true,
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Guides", link: "/guides/" },
      { text: "Architecture", link: "/architecture/" },
      { text: "ADRs", link: "/adrs/" },
      { text: "Contributing", link: "/contributing" },
    ],
    sidebar: {
      "/guides/": [
        {
          text: "Guides",
          items: [
            { text: "Overview", link: "/guides/" },
            { text: "Local Development", link: "/guides/local-development" },
          ],
        },
      ],
      "/architecture/": [
        {
          text: "Architecture Patterns",
          items: [{ text: "Overview", link: "/architecture/" }],
        },
      ],
      "/adrs/": [
        {
          text: "ADRs",
          items: [
            { text: "ADR Log", link: "/adrs/" },
            { text: "Template", link: "/adrs/template" },
            { text: "0001 – Record Architecture Decisions", link: "/adrs/0001-record-architecture-decisions" },
          ],
        },
      ],
      "/": [
        {
          text: "Meta",
          items: [{ text: "How to Write Docs", link: "/contributing" }],
        },
      ],
    },
    outline: "deep",
  },
  markdown: {
    config(md) {
      // Render ```mermaid fences as <pre class="mermaid"> so the theme's
      // client-side hook can turn them into diagrams (see theme/index.ts).
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        if (token.info.trim() === "mermaid") {
          return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
        }
        return fence(tokens, idx, options, env, self);
      };
    },
  },
});
