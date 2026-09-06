import { useEffect, useState } from 'react'
import {
  getCapabilities, getHealth, getSettings,
  type Capabilities, type Handoff, type Health, type NamerSettings,
} from './api'
import ConvertView from './views/ConvertView'
import AnalysisView from './views/AnalysisView'
import SettingsView from './views/SettingsView'
import { navigate, RouteLink, useRoute, type Route } from './router'

// Settings is a view like the others, but it is not a step in the work, so
// it is reached from the gear in the corner rather than from the tab bar.
const TABS: { id: Route; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'analysis', label: 'Analysis' },
]

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [settings, setSettings] = useState<NamerSettings | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const tab = useRoute()
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
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z" />
            <path d="M3 7.5 12 12.5l9-5M12 12.5v9" />
          </svg>
          3D Model Converter <small>Blender-powered</small>
        </div>

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
      </header>

      {bootError && (
        <div style={{ padding: '20px 24px' }}>
          <div className="error-box">Could not reach the backend: {bootError}</div>
        </div>
      )}

      {/* Both tabs stay mounted so a running job -- and its result -- survives a
          switch; the hidden one parks its render loop rather than burning GPU. */}
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
