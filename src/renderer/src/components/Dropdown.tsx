import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import type React from 'react'

export interface DropdownOption {
  value: string
  label: string
  description?: string
  /** Options with a new section value get a muted header before them (not selectable, skipped by the keyboard). */
  section?: string
}

export default function Dropdown({
  value,
  options,
  onChange,
  icon,
  placement = 'down',
  title,
  className = '',
  labelOverride,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  icon?: React.ReactNode
  placement?: 'up' | 'down'
  title?: string
  className?: string
  /** Text for the trigger when it should differ from the selected option's label. */
  labelOverride?: string
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setHi((h) => (h + dir + options.length) % options.length)
      } else if (e.key === 'Enter' && hi >= 0) {
        e.preventDefault()
        onChange(options[hi].value)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, hi, options, onChange])

  // Keep the menu inside the viewport horizontally (narrow phone screens).
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!open || !el) return
    el.style.translate = ''
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    let dx = 0
    if (r.right > vw - 8) dx = vw - 8 - r.right
    if (r.left + dx < 8) dx = 8 - r.left
    if (dx) el.style.translate = `${Math.round(dx)}px 0`
  }, [open, options])

  useEffect(() => {
    if (open) setHi(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open, options, value])

  return (
    <div className={`dd ${className}`} ref={root}>
      <button type="button" className={`dd-trigger ${open ? 'open' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {icon}
        <span className="dd-label">{labelOverride ?? selected?.label ?? value}</span>
        <ChevronDown size={12} className="dd-chev" />
      </button>
      {open && (
        <div ref={menuRef} className={`dd-menu ${placement === 'up' ? 'dd-up' : 'dd-down'}`} role="listbox">
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.section && o.section !== options[i - 1]?.section && <div className="dd-section">{o.section}</div>}
            <button
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-item ${o.value === value ? 'selected' : ''} ${i === hi ? 'hi' : ''}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span className="dd-item-text">
                <span className="dd-item-label">{o.label}</span>
                {o.description && <span className="dd-item-desc">{o.description}</span>}
              </span>
              {o.value === value && <Check size={13} className="dd-check" />}
            </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
