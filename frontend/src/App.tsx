import { useEffect, useState } from 'react'
import {
  getCapabilities, getHealth, getSettings,
  type Capabilities, type Handoff, type Health, type NamerSettings,
} from './api'
import ConvertView from './views/ConvertView'
import AnalysisView from './views/AnalysisView'
import SettingsView from './views/SettingsView'
import HomeView from './views/HomeView'
import PointField from './components/PointField'
import { navigate, RouteLink, useRoute, type Route } from './router'
import { useTheme, type Choice } from './theme'

// Settings is a view like the others, but it is not a step in the work, so
// it is reached from the gear in the corner rather than from the tab bar.
const TABS: { id: Route; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'convert', label: 'Convert' },
  { id: 'analysis', label: 'Analysis' },
]

// Round-trips back to 'system', so handing the decision back to the machine is
// as reachable as taking it away -- an override you cannot undo is a trap.
const NEXT: Record<Choice, Choice> = { system: 'light', light: 'dark', dark: 'system' }
const SAYS: Record<Choice, string> = {
  system: 'Matching your system theme',
  light: 'Light theme',
  dark: 'Dark theme',
}

/** Monitor, sun, moon: what the button is set to, not what it will do next. */
function ThemeIcon({ choice }: { choice: Choice }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  if (choice === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    )
  }
  if (choice === 'dark') {
    return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
  }
  return (
    <svg {...common}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  )
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [settings, setSettings] = useState<NamerSettings | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const tab = useRoute()
  const { choice, choose } = useTheme()
  // A conversion sent over from the Convert tab, cleared once Analysis has
  // picked it up so that switching tabs later does not re-run it.
  const [handoff, setHandoff] = useState<Handoff | null>(null)

  useEffect(() => {
    Promise.all([getHealth(), getCapabilities()])
      .then(([h, c]) => { setHealth(h); setCaps(c) })
      .catch((e: Error) => setBootError(e.message))
    // Settings are read separately: the app is perfectly usable without
    // them, so they must not be able to fail the boot.
    getSettings().then(setSettings).catch(() => setSettings(null))
  }, [])

  return (
    <div className="app">
      {/* Home only. On the tool views the model is the 3D on screen, and a field
          drifting behind a part list is something to look past rather than at --
          so it is not merely hidden there, it is unmounted, and stops drawing. */}
      {tab === 'home' && <PointField />}

      <header className="topbar">
        {/* The page's one h1: the outline started at h2 without it, and every
            view's own heading hangs off this. */}
        <h1 className="brand">
          {/* An aperture with something passing through it, which is what this
              stage of the pipeline does to a file. */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2.6 21.4 12 12 21.4 2.6 12z" />
            <path d="M10.2 8.8 13.4 12l-3.2 3.2" />
          </svg>
          Create-AR <small>Blender-powered</small>
        </h1>

        <nav className="tabs">
          {TABS.map((t) => (
            <RouteLink key={t.id} to={t.id} className={`tab${tab === t.id ? ' sel' : ''}`}>
              {t.label}
            </RouteLink>
          ))}
        </nav>

        <div className="topbar-spacer" />
        {health && (
          <span className={`badge ${health.ok ? 'ok' : 'bad'}`} title={health.blenderPath ?? ''}>
            <i className="dot" />
            {health.ok ? (health.blenderVersion ?? 'Blender ready') : 'Blender not found'}
          </span>
        )}
        {health?.cadSupport && (
          <span className="badge ok"><i className="dot" />STEP / IGES ready</span>
        )}
        {/* Grouped so the two icon buttons wrap as one thing. Loose, they split
            across rows on a narrow window and leave the header a row taller
            than it needs to be. */}
        <div className="topbar-actions">
          <button
            className="gear"
            onClick={() => choose(NEXT[choice])}
            title={`${SAYS[choice]} — click for ${SAYS[NEXT[choice]].toLowerCase()}`}
            aria-label={`Theme: ${SAYS[choice].toLowerCase()}. Change it.`}
          >
            <ThemeIcon choice={choice} />
          </button>

          <RouteLink
            to={tab === 'settings' ? 'convert' : 'settings'}
            className={`gear${tab === 'settings' ? ' sel' : ''}`}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </RouteLink>
        </div>
      </header>

      {bootError && (
        <div style={{ padding: '20px 24px' }}>
          <div className="error-box">Could not reach the backend: {bootError}</div>
        </div>
      )}

      <div className="view" hidden={tab !== 'home'}>
        <HomeView health={health} caps={caps} />
      </div>

      {/* Both tool tabs stay mounted so a running job -- and its result --
          survives a switch; the hidden one parks its render loop rather than
          burning GPU. */}
      <div className="view" hidden={tab !== 'convert'}>
        <ConvertView
          health={health}
          caps={caps}
          active={tab === 'convert'}
          onAnalyse={(h) => { setHandoff(h); navigate('analysis') }}
        />
      </div>
      <div className="view" hidden={tab !== 'analysis'}>
        <AnalysisView
          health={health}
          caps={caps}
          active={tab === 'analysis'}
          settings={settings}
          onOpenSettings={() => navigate('settings')}
          incoming={handoff}
          onIncomingTaken={() => setHandoff(null)}
        />
      </div>
      <div className="view" hidden={tab !== 'settings'}>
        <SettingsView settings={settings} onSaved={setSettings} />
      </div>
    </div>
  )
}
