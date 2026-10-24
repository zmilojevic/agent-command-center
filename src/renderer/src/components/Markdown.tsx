import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Copy, Check } from 'lucide-react'
import { looksLikePath } from '../util'

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const lang = /language-(\w+)/.exec(className ?? '')?.[1]
  const text = extractText(children)
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang ?? 'text'}</span>
        <button
          className="icon-btn tiny"
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) return extractText((node as any).props?.children)
  return ''
}

const MENTION_RE = /@agent-[\w.:-]*\w/g

/** Wraps `@agent-<name>` in text nodes (outside code/pre) in a styled span. */
function rehypeAgentMentions() {
  const walk = (node: any): void => {
    if (!node.children) return
    const out: any[] = []
    for (const child of node.children) {
      if (child.type === 'element' && (child.tagName === 'code' || child.tagName === 'pre')) {
        out.push(child)
        continue
      }
      if (child.type !== 'text' || !child.value.includes('@agent-')) {
        walk(child)
        out.push(child)
        continue
      }
      let last = 0
      for (const m of child.value.matchAll(MENTION_RE)) {
        if (m.index > last) out.push({ type: 'text', value: child.value.slice(last, m.index) })
        out.push({ type: 'element', tagName: 'span', properties: { className: ['agent-mention'] }, children: [{ type: 'text', value: m[0] }] })
        last = m.index + m[0].length
      }
      if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) })
    }
    node.children = out
  }
  return (tree: any) => walk(tree)
}

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md ${streaming ? 'streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeAgentMentions]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...rest }) => {
            const inline = !className && !String(children).includes('\n')
            if (inline) {
              return (
                <code className={looksLikePath(String(children)) ? 'inline path' : 'inline'} {...rest}>
                  {children}
                </code>
              )
            }
            return <CodeBlock className={className}>{children}</CodeBlock>
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
