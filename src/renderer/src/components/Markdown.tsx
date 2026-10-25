import { memo, useState } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Copy, Check, SquareTerminal } from 'lucide-react'
import { looksLikePath, copyText, isPhone, shellCommandText } from '../util'
import { useStore } from '../store'
import { activeProjectCwd, openFileInEditor, splitLine } from '../openIn'

const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shellsession', 'fish', 'ps1', 'powershell', 'pwsh'])

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const lang = /language-(\w+)/.exec(className ?? '')?.[1]
  const text = extractText(children)
  const shell = !!lang && SHELL_LANGS.has(lang.toLowerCase()) && !isPhone && !!activeProjectCwd()
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang ?? 'text'}</span>
        <span className="codeblock-actions">
        {shell && (
          <button
            className="icon-btn tiny"
            title="Run in terminal (Shift+click: paste without running)"
            onClick={(e) => {
              const cwd = activeProjectCwd()
              if (cwd) void useStore.getState().runInTerminal(cwd, shellCommandText(text), !e.shiftKey)
            }}
          >
            <SquareTerminal size={12} />
          </button>
        )}
        <button
          className="icon-btn tiny"
          title="Copy"
          onClick={() => {
            void copyText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        </span>
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
// `@path` / `@"path with spaces"` file mentions in sent user messages (a path has a '/' or a '.'; emails don't match).
const FILE_MENTION_RE = /(?<![\w@.])@(?:agent-[\w.:-]*\w|"[^"\n]+"|(?=[^\s@"]*[/.])[^\s@"]*[\w/~-])/g

/** Wraps `@agent-<name>` (and with `files` also `@path`) in text nodes (outside code/pre) in a styled span. */
function rehypeMentions(opts?: { files?: boolean }) {
  const files = opts?.files
  const re = files ? FILE_MENTION_RE : MENTION_RE
  const walk = (node: any): void => {
    if (!node.children) return
    const out: any[] = []
    for (const child of node.children) {
      if (child.type === 'element' && (child.tagName === 'code' || child.tagName === 'pre')) {
        out.push(child)
        continue
      }
      if (child.type !== 'text' || !child.value.includes(files ? '@' : '@agent-')) {
        walk(child)
        out.push(child)
        continue
      }
      let last = 0
      for (const m of child.value.matchAll(re)) {
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

const PLUGINS_AGENTS: NonNullable<Options['rehypePlugins']> = [rehypeHighlight, [rehypeMentions, { files: false }]]
const PLUGINS_FILES: NonNullable<Options['rehypePlugins']> = [rehypeHighlight, [rehypeMentions, { files: true }]]

const Markdown = memo(function Markdown({ text, streaming, files }: { text: string; streaming?: boolean; files?: boolean }) {
  return (
    <div className={`md ${streaming ? 'streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={files ? PLUGINS_FILES : PLUGINS_AGENTS}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...rest }) => {
            const inline = !className && !String(children).includes('\n')
            if (inline) {
              const text = String(children)
              const isPath = looksLikePath(text)
              // Paths in project chats open in the editor on click (relative ones against the chat's folder).
              const cwd = isPath ? activeProjectCwd() : undefined
              if (cwd) {
                return (
                  <code
                    className="inline path openable"
                    title="Open in editor"
                    onClick={() => {
                      const { path, line } = splitLine(text.trim())
                      void openFileInEditor(path, cwd, line)
                    }}
                    {...rest}
                  >
                    {children}
                  </code>
                )
              }
              return (
                <code className={isPath ? 'inline path' : 'inline'} {...rest}>
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
