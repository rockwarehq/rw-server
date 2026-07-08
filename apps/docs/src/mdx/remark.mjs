import { mdxAnnotations } from 'mdx-annotations'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'

// Turn ```mermaid fences into <Mermaid code="..." /> before the rehype
// pipeline (Shiki) treats them as code to highlight. Rendering happens
// client-side in src/components/Mermaid.tsx.
function remarkMermaid() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || !parent || index === undefined) return
      parent.children[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'code', value: node.value },
        ],
        children: [],
      }
    })
  }
}

export const remarkPlugins = [mdxAnnotations.remark, remarkGfm, remarkMermaid]
