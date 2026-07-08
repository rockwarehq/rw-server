'use client'

import { useTheme } from 'next-themes'
import { useEffect, useId, useState } from 'react'

export function Mermaid({ code }: { code: string }) {
  let id = useId().replace(/[^a-zA-Z0-9]/g, '')
  let { resolvedTheme } = useTheme()
  let [svg, setSvg] = useState('')

  useEffect(() => {
    let cancelled = false

    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
      })
      try {
        let { svg } = await mermaid.render(`mermaid-${id}`, code)
        if (!cancelled) setSvg(svg)
      } catch {
        // Leave the placeholder in place if the diagram source is invalid.
      }
    })

    return () => {
      cancelled = true
    }
  }, [code, resolvedTheme, id])

  if (!svg) {
    return (
      <div className="my-6 text-sm text-zinc-500 dark:text-zinc-400">
        Rendering diagram…
      </div>
    )
  }

  return (
    <div
      className="my-6 flex justify-center *:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
