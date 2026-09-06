import { useState } from 'react'
import { saveSettings, type NamerSettings, type Provider } from '../api'

/**
 * The app's settings, in one place.
 *
 * They live on the server, in the data directory the jobs go in -- which is
 * git-ignored, and is what a deployment points at a volume. That is where the
 * API keys have to live: they are needed on the server anyway, and putting them
 * there keeps them out of the repository and out of every browser but the one
 * that typed them.
 *
 * A key is write-only from here. The server never sends one back, only which
 * providers it is holding one for, so a key field is blank whenever a key is
 * already stored and saving with it blank leaves that key alone. Every
 * provider's key is kept even while another is selected, so trying Claude for
 * an afternoon does not cost you the Azure key you had typed in.
 *
 * That blank field is not an empty setting: the dot beside a provider and the
 * placeholder in the field are how a stored key shows itself, since showing
 * the key would undo the reason it is only ever written.
 */

const PROVIDERS: { id: Provider; label: string; note: string }[] = [
  { id: 'azure', label: 'Azure OpenAI', note: 'A deployment in your own Azure resource.' },
  { id: 'openai', label: 'OpenAI', note: 'api.openai.com, with an OpenAI key.' },
  { id: 'anthropic', label: 'Anthropic', note: 'Claude, with an Anthropic key.' },
  { id: 'compatible', label: 'OpenAI-compatible URL', note: 'Anything else that speaks the same API — a local server, a gateway, a router.' },
]

export default function SettingsView({ settings, onSaved }: {
  settings: NamerSettings | null
  onSaved: (settings: NamerSettings) => void
}) {
  const [form, setForm] = useState<NamerSettings | null>(settings)
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({})
  const [forget, setForget] = useState<Provider | undefined>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The settings arrive after the first render, so seed the form when they do.
  const [seeded, setSeeded] = useState(settings != null)
  if (!seeded && settings) {
    setSeeded(true)
    setForm(settings)
  }

  if (!form) {
    return <div className="settings"><section className="card">
      <div className="empty">Loading settings…</div>
    </section></div>
  }

  const set = <K extends keyof NamerSettings>(field: K, value: NamerSettings[K]) => {
    setForm((was) => (was ? { ...was, [field]: value } : was))
    setSaved(false)
  }

  const typeKey = (provider: Provider, value: string) => {
    setKeys((was) => ({ ...was, [provider]: value }))
    if (forget === provider) setForget(undefined)
    setSaved(false)
  }

  async function save() {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      const next = await saveSettings(form, keys, forget)
      onSaved(next)
      setForm(next)
      setKeys({})
      setForget(undefined)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** A key field, with its stored/forget state. Every provider has one. */
  const keyField = (provider: Provider, id: string, optional = false) => {
    const held = form.keys[provider] && forget !== provider
    return (
      <div className="field">
        <label htmlFor={id}>API key{optional && ' (optional)'}</label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          placeholder={held ? 'A key is stored — type here to replace it'
            : optional ? 'Leave empty if the server does not need one' : 'Paste the key'}
          value={keys[provider] ?? ''}
          onChange={(e) => typeKey(provider, e.target.value)}
        />
        {held && !keys[provider] && (
          <button className="field-side" onClick={() => { setForget(provider); setSaved(false) }}>
            Forget the stored key
          </button>
        )}
        {forget === provider && (
          <span className="field-side warn">The stored key will be removed on save.</span>
        )}
      </div>
    )
  }

  const text = (
    field: keyof NamerSettings, id: string, label: string,
    placeholder = '', hint = '',
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        value={String(form[field] ?? '')}
        onChange={(e) => set(field, e.target.value as NamerSettings[typeof field])}
      />
      {hint && <span className="field-side">{hint}</span>}
    </div>
  )

  return (
    <div className="settings">
      <section className="card">
        <div className="card-head">
          <h2>Part naming</h2>
          <span className={`badge ${form.configured ? 'ok' : 'bad'}`} style={{ marginLeft: 'auto' }}>
            <i className="dot" />
            {form.configured ? 'Ready' : 'Not set up'}
          </span>
        </div>

        <div className="card-body">
          <div className="group-label">Provider</div>
          <div className="providers">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`provider${form.provider === p.id ? ' sel' : ''}`}
                onClick={() => set('provider', p.id)}
              >
                <span className="provider-name">
                  {p.label}
                  {form.keys[p.id] && <i className="provider-key" title="A key is stored" />}
                </span>
                <span className="provider-note">{p.note}</span>
              </button>
            ))}
          </div>

          {form.provider === 'azure' && (
            <>
              {text('azure_endpoint', 'az-endpoint', 'Endpoint',
                'https://my-resource.openai.azure.com')}
              {keyField('azure', 'az-key')}
              {text('azure_deployment', 'az-deployment', 'Deployment',
                'the deployment name, not the model name',
                'It has to be a deployment that accepts images.')}
              {text('azure_api_version', 'az-version', 'API version')}
            </>
          )}

          {form.provider === 'openai' && (
            <>
              {keyField('openai', 'oa-key')}
              {text('openai_model', 'oa-model', 'Model', 'gpt-4o',
                'Any OpenAI model that accepts images.')}
            </>
          )}

          {form.provider === 'anthropic' && (
            <>
              {keyField('anthropic', 'an-key')}
              {text('anthropic_model', 'an-model', 'Model', 'claude-opus-5',
                'Any Claude model — they all accept images.')}
            </>
          )}

          {form.provider === 'compatible' && (
            <>
              {text('compatible_url', 'cp-url', 'Base URL',
                'http://localhost:11434/v1',
                'Where /chat/completions lives. Include the version path.')}
              {keyField('compatible', 'cp-key', true)}
              {text('compatible_model', 'cp-model', 'Model', '',
                'Whatever name the server knows the model by.')}
            </>
          )}

          <div className="group-label">How the parts are sent</div>

          <div className="opt-row">
            <label htmlFor="nm-mode">Requests</label>
            <div className="ctl">
              <select
                id="nm-mode"
                style={{ width: 200 }}
                value={form.mode}
                onChange={(e) => set('mode', e.target.value as NamerSettings['mode'])}
              >
                <option value="single">One part per request</option>
                <option value="batch">Several parts per request</option>
              </select>
            </div>
          </div>

          <div className="opt-row">
            <label htmlFor="nm-batch">Parts per request</label>
            <div className="ctl">
              <input
                id="nm-batch" type="number" min={1} max={24}
                disabled={form.mode !== 'batch'}
                value={form.batch_size}
                onChange={(e) => set('batch_size', Number(e.target.value))}
              />
            </div>
          </div>

          <div className="opt-row">
            <label htmlFor="nm-conc">Requests at once</label>
            <div className="ctl">
              <input
                id="nm-conc" type="number" min={1} max={8}
                value={form.concurrency}
                onChange={(e) => set('concurrency', Number(e.target.value))}
              />
            </div>
          </div>

          <div className="opt-row">
            <label htmlFor="nm-context">Show each part in the assembly</label>
            <div className="ctl">
              <label className="switch">
                <input
                  id="nm-context" type="checkbox"
                  checked={form.context_shot}
                  onChange={(e) => set('context_shot', e.target.checked)}
                />
                <span />
              </label>
            </div>
          </div>

          <div className="opt-row">
            <label htmlFor="nm-describe">Describe each part, not just name it</label>
            <div className="ctl">
              <label className="switch">
                <input
                  id="nm-describe" type="checkbox"
                  checked={form.describe}
                  onChange={(e) => set('describe', e.target.checked)}
                />
                <span />
              </label>
            </div>
          </div>

          <div className="note">
            With descriptions on, the model also says what each part is, what it
            does, how it is used and whatever else applies — that is what fills
            the <code>parts.json</code> in an exported bundle and the panel in
            the viewer. It costs a good deal more per part, and is slower. Off,
            a run only renames.
          </div>

          <div className="note">
            Batching is cheaper and much faster, and lets the model tell sibling
            parts apart instead of calling five of them the same thing. One part
            per request gives each part the model's whole attention, which can be
            worth it for a small model of unusual parts. The second picture — the
            part lit up inside the whole assembly — is what tells a wheel hub from
            a spacer; it roughly doubles the image cost. Any name two parts end up
            sharing is numbered, whatever you choose here.
          </div>

          <div className="group-label">Instructions</div>
          <textarea
            className="prompt"
            rows={12}
            value={form.instructions}
            onChange={(e) => set('instructions', e.target.value)}
          />
          <div className="note">
            The reply format is not set here — it is added to every request
            separately, so rewriting these instructions cannot break the naming.
          </div>

          {form.describe && (
            <>
              <div className="group-label">Description instructions</div>
              <textarea
                className="prompt"
                rows={9}
                value={form.describe_instructions}
                onChange={(e) => set('describe_instructions', e.target.value)}
              />
              <div className="note">
                Added to the instructions above only when descriptions are on.
                The labels are deliberately not a fixed list — what is worth
                saying about a bearing is not what is worth saying about a
                wiring loom, and the viewer shows whatever comes back.
              </div>
            </>
          )}

          {error && <div className="error-box" style={{ marginTop: 14 }}>{error}</div>}

          <button className="go" style={{ marginTop: 14 }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
          </button>
          <div className="note">
            Everything here is saved on this machine, in the data directory
            alongside the jobs, and read back on the next start — nothing needs
            typing twice. That directory is git-ignored and excluded from the
            Docker build, so none of it reaches the repository or an image.
            API keys are encrypted in that file rather than written in the
            clear, and leave only in the request to the provider you picked.
          </div>
        </div>
      </section>
    </div>
  )
}
