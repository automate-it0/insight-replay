"use client"

// Minimal, safe-ish markdown renderer (headings, bold, lists, paragraphs, code).
export function Markdown({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/)
  return (
    <div className="text-sm leading-relaxed space-y-3">
      {blocks.map((b, i) => {
        const trimmed = b.trim()
        if (!trimmed) return null
        // heading
        const h = /^(#{1,4})\s+(.*)$/.exec(trimmed)
        if (h) {
          const level = h[1].length
          const text = renderInline(h[2])
          if (level === 1) return <h2 key={i} className="text-lg font-semibold mt-4">{text}</h2>
          if (level === 2) return <h3 key={i} className="text-base font-semibold mt-3 text-primary">{text}</h3>
          if (level === 3) return <h4 key={i} className="text-sm font-semibold mt-2">{text}</h4>
          return <h5 key={i} className="text-sm font-medium mt-2">{text}</h5>
        }
        // list
        if (/^[-*]\s/.test(trimmed)) {
          const items = trimmed.split(/\n/).filter((l) => /^[-*]\s/.test(l)).map((l) => l.replace(/^[-*]\s/, ""))
          return (
            <ul key={i} className="space-y-1.5">
              {items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-primary mt-1">•</span>
                  <span>{renderInline(it)}</span>
                </li>
              ))}
            </ul>
          )
        }
        // numbered list
        if (/^\d+\.\s/.test(trimmed)) {
          const items = trimmed.split(/\n/).filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s/, ""))
          return (
            <ol key={i} className="space-y-1.5">
              {items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-primary font-medium">{j + 1}.</span>
                  <span>{renderInline(it)}</span>
                </li>
              ))}
            </ol>
          )
        }
        // code block
        if (trimmed.startsWith("```")) {
          const code = trimmed.replace(/^```\w*\n?/, "").replace(/```$/, "")
          return <pre key={i} className="text-xs font-mono bg-background/60 p-3 rounded-lg overflow-x-auto scroll-thin">{code}</pre>
        }
        // paragraph
        return <p key={i}>{renderInline(trimmed)}</p>
      })}
    </div>
  )
}

function renderInline(text: string): React.ReactNode {
  // Split on **bold** and `code`
  const parts: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("**")) {
      parts.push(<strong key={k++} className="font-semibold text-foreground">{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith("`")) {
      parts.push(<code key={k++} className="text-xs font-mono px-1 py-0.5 rounded bg-primary/15 text-primary">{tok.slice(1, -1)}</code>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
