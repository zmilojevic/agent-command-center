import { createElement, type ReactNode } from 'react'
import { common, createLowlight } from 'lowlight'

const lowlight = createLowlight(common)

const EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', lua: 'lua', gradle: 'gradle', groovy: 'groovy',
}
const NAMES: Record<string, string> = { makefile: 'makefile', dockerfile: 'dockerfile' }

/** lowlight language for a file path (by extension or well-known file name), or null. */
export function langForPath(path: string): string | null {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  const dot = base.lastIndexOf('.')
  const lang = NAMES[base] ?? (dot >= 0 ? EXT[base.slice(dot + 1)] : undefined)
  return lang && lowlight.registered(lang) ? lang : null
}

type HNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HNode[] }

const MAX_TOTAL = 200_000
const MAX_LINE = 2000

/** Highlight lines as one block (so multi-line strings/comments keep context) and return per-line React nodes; null = show plain text. */
export function highlightLines(lines: string[], lang: string | null): ReactNode[] | null {
  if (!lang || lines.length === 0) return null
  let total = 0
  for (const l of lines) {
    if (l.length > MAX_LINE) return null
    total += l.length + 1
  }
  if (total > MAX_TOTAL) return null
  try {
    const tree = lowlight.highlight(lang, lines.join('\n')) as unknown as HNode
    const out: ReactNode[][] = [[]]
    let key = 0
    const walk = (n: HNode, classes: string[]): void => {
      if (n.type === 'text') {
        const parts = (n.value ?? '').split('\n')
        parts.forEach((p, i) => {
          if (i > 0) out.push([])
          if (!p) return
          const cur = out[out.length - 1]
          cur.push(classes.length ? createElement('span', { key: key++, className: classes.join(' ') }, p) : p)
        })
      } else if (n.type === 'element') {
        const c = n.properties?.className
        const next = Array.isArray(c) ? [...classes, ...c.map(String)] : classes
        for (const ch of n.children ?? []) walk(ch, next)
      } else {
        for (const ch of n.children ?? []) walk(ch, classes)
      }
    }
    walk(tree, [])
    if (out.length !== lines.length) return null
    return out
  } catch {
    return null
  }
}

/** Highlight diff rows per hunk (a 'hunk' row starts a new one): del rows from the old side, add and ctx rows from the new side. */
export function highlightRows<T extends { kind: string; text: string }>(rows: T[], lang: string | null): Map<T, ReactNode> {
  const map = new Map<T, ReactNode>()
  if (!lang) return map
  let oldSide: T[] = []
  let newSide: T[] = []
  const flush = (): void => {
    for (const side of [oldSide, newSide]) {
      const nodes = highlightLines(
        side.map((r) => r.text),
        lang,
      )
      if (nodes) side.forEach((r, i) => map.set(r, nodes[i]))
    }
    oldSide = []
    newSide = []
  }
  for (const r of rows) {
    if (r.kind === 'hunk') flush()
    else {
      if (r.kind !== 'add') oldSide.push(r)
      if (r.kind !== 'del') newSide.push(r)
    }
  }
  flush()
  return map
}
