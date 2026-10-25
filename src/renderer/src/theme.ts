import { useStore } from './store'
import type { Theme } from '@shared/types'

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** Resolve the preference to the palette actually shown and stamp it on <html> for the CSS. */
function apply(theme: Theme): void {
  const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}

/** `diffTint` pref → <html data-diff-tint="gutter"> (absent = whole-line tint). */
function applyTint(t: string): void {
  if (t === 'gutter') document.documentElement.dataset.diffTint = 'gutter'
  else delete document.documentElement.dataset.diffTint
}

/**
 * Keep <html data-theme> in sync with the store's theme pref and the OS setting.
 * The pref is also mirrored into Electron's nativeTheme so the window background and
 * native widgets match; when it is 'system' that resets nativeTheme to follow the OS,
 * which updates the media query and re-applies here.
 */
export function initTheme(): void {
  let tint = useStore.getState().diffTint
  applyTint(tint)
  let current = useStore.getState().theme
  apply(current)
  window.desktop.setTheme?.(current)
  useStore.subscribe((s) => {
    if (s.diffTint !== tint) {
      tint = s.diffTint
      applyTint(tint)
    }
    if (s.theme === current) return
    current = s.theme
    apply(current)
    window.desktop.setTheme?.(current)
  })
  media.addEventListener('change', () => apply(current))
}
