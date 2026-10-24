import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import type React from 'react'

export interface DropdownOption {
  value: string
  label: string
  description?: string
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
        <div className={`dd-menu ${placement === 'up' ? 'dd-up' : 'dd-down'}`} role="listbox">
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
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
          ))}
        </div>
      )}
    </div>
  )
}
