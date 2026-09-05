import { useEffect, useState } from 'react'
import { getCapabilities, getHealth, type Capabilities, type Health } from './api'
import ConvertView from './views/ConvertView'
import AnalysisView from './views/AnalysisView'

type Tab = 'convert' | 'analysis'

const TABS: { id: Tab; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'analysis', label: 'Analysis' },
]

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('convert')

  useEffect(() => {
    Promise.all([getHealth(), getCapabilities()])
      .then(([h, c]) => { setHealth(h); setCaps(c) })
      .catch((e: Error) => setBootError(e.message))
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
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' sel' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
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
      </header>

      {bootError && (
        <div style={{ padding: '20px 24px' }}>
          <div className="error-box">Could not reach the backend: {bootError}</div>
        </div>
      )}

      {/* Both tabs stay mounted so a running job -- and its result -- survives a
          switch; the hidden one parks its render loop rather than burning GPU. */}
      <div className="view" hidden={tab !== 'convert'}>
        <ConvertView health={health} caps={caps} active={tab === 'convert'} />
      </div>
      <div className="view" hidden={tab !== 'analysis'}>
        <AnalysisView health={health} caps={caps} active={tab === 'analysis'} />
      </div>
    </div>
  )
}
