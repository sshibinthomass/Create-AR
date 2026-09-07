/**
 * Light or dark, and who decided.
 *
 * The stylesheet does the real work: dark is the base, and light arrives through
 * a `prefers-color-scheme` query. That is deliberate rather than lazy -- it means
 * a machine set to light paints light on the very first frame, with no script
 * having run, so the page never flashes the wrong theme on load.
 *
 * This module only handles the override. `data-theme` goes on the root element
 * when someone has actually chosen, and comes off again when they hand the
 * decision back to the machine, at which point the media query takes over again.
 */
import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'
/** A theme, or leaving it to whatever the machine is set to. */
export type Choice = Theme | 'system'

const KEY = 'converter.theme'
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

function stored(): Choice {
  try {
    const held = localStorage.getItem(KEY)
    return held === 'light' || held === 'dark' ? held : 'system'
  } catch {
    // A private window refuses storage; the choice just does not outlive the tab.
    return 'system'
  }
}

/** Which theme is on screen right now, however it got chosen. */
function showing(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return prefersDark.matches ? 'dark' : 'light'
}

/**
 * The theme control. Called once, by the app shell -- it writes the root
 * attribute and the stored choice, and two of those writing at once would fight.
 */
export function useTheme(): { choice: Choice; theme: Theme; choose: (next: Choice) => void } {
  const [choice, choose] = useState<Choice>(stored)
  const [system, setSystem] = useState<Theme>(() => (prefersDark.matches ? 'dark' : 'light'))

  useEffect(() => {
    const sync = () => setSystem(prefersDark.matches ? 'dark' : 'light')
    prefersDark.addEventListener('change', sync)
    return () => prefersDark.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = choice
    try {
      if (choice === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, choice)
    } catch { /* see stored() */ }
  }, [choice])

  return { choice, theme: choice === 'system' ? system : choice, choose }
}

/**
 * Read-only, for anything that has to follow the theme but cannot use CSS --
 * which here means the 3D scene, since WebGL draws its own background.
 *
 * Watches both ways the theme can move: the machine's setting changing under a
 * run left on 'system', and the attribute being written by the control above.
 */
export function useThemeValue(): Theme {
  const [theme, setTheme] = useState(showing)
  useEffect(() => {
    const sync = () => setTheme(showing())
    prefersDark.addEventListener('change', sync)
    const watch = new MutationObserver(sync)
    watch.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    return () => {
      prefersDark.removeEventListener('change', sync)
      watch.disconnect()
    }
  }, [])
  return theme
}

/** What a colour token currently resolves to, for the same non-CSS callers. */
export const cssColor = (token: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#808080'
