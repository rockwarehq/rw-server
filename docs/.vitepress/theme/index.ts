import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { nextTick, onMounted, watch } from "vue";

// Renders <pre class="mermaid"> blocks (emitted by the markdown fence override
// in config.mts) into diagrams. Mermaid is imported lazily on the client only,
// so SSR/build never touches it.
export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute();

    const renderMermaid = async () => {
      if (typeof window === "undefined") return;
      if (!document.querySelector("pre.mermaid")) return;
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, theme: "neutral" });
      await mermaid.run({ querySelector: "pre.mermaid" });
    };

    onMounted(renderMermaid);
    watch(
      () => route.path,
      () => nextTick(renderMermaid),
    );
  },
};
