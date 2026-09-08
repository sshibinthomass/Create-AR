/**
 * The landing page, and the only place in the app with a 3D background.
 *
 * Built out of the design system's own band classes rather than the app's tool
 * chrome -- .light-section / .dark-section, .container, .eyebrow,
 * .section-heading, .button-link, .workflow. Those bands are translucent and
 * blurred by design, so the point field behind them is the point: this is the
 * one page where the depth is the design rather than a distraction from a
 * model.
 *
 * The format list and the two status chips come from /api/formats and
 * /api/health, which the app shell already fetches for the tool views. A home
 * page that claimed support for a format the running backend cannot actually
 * export would be worse than no home page.
 */
import { RouteLink } from '../router'
import type { Capabilities, Health } from '../api'

/** Format families, in the order someone converting for AR would care about. */
const FAMILIES: { label: string; exts: string[]; note: string }[] = [
  { label: 'AR and web', exts: ['.glb', '.gltf', '.usdz'], note: 'Quick Look, WebXR, Android Scene Viewer' },
  { label: 'Interchange', exts: ['.fbx', '.obj', '.abc'], note: 'Hand-off between DCC tools' },
  { label: 'Mesh', exts: ['.stl', '.ply'], note: 'Print and scan pipelines' },
  { label: 'USD', exts: ['.usd', '.usda', '.usdc'], note: 'Pixar USD, all three encodings' },
  // The one family that is not round-trippable, and the reason the band says so.
  { label: 'CAD and containers', exts: ['.step', '.iges', '.zip', '.7z'], note: 'Tessellated or unpacked on the way in' },
]

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Drop a file in',
    body: 'Any of the formats below, or a zip, 7z or tar with the model somewhere inside it.',
  },
  {
    title: 'CAD and archives are opened first',
    body: 'STEP and IGES are tessellated with OpenCASCADE, because Blender has no CAD kernel of its own. Containers are identified by magic bytes and searched to any depth.',
  },
  {
    title: 'Blender does the conversion',
    body: 'A headless Blender process imports, transforms and exports, reporting progress as it goes.',
  },
  {
    title: 'Look at what came back',
    body: 'The result renders in the browser next to the download, so you can see it is right before you ship it.',
  },
]

export default function HomeView({ health, caps }: {
  health: Health | null
  caps: Capabilities | null
}) {
  // Only claim what this backend actually reports it can do.
  const exportable = new Set((caps?.formats ?? []).filter((f) => f.can_export).map((f) => f.ext))
  const importable = new Set(caps?.inputs ?? [])

  return (
    <>
      {/* No band class: see .home-hero -- a DS band would blur the field away. */}
      <section className="home-hero">
        <div className="container">
          <p className="eyebrow">Create-AR · convert</p>
          <h2 className="home-title">
            Convert a model, then see that it came back right.
          </h2>
          <p className="section-heading__intro large-copy reading-width">
            Drop in a 3D model, pick the format you need, and get it back converted by
            a headless Blender — with the result on screen next to the download, and
            an exploded view that names every part it was built from.
          </p>

          <div className="hero-actions home-cta">
            <RouteLink to="convert" className="button-link button-link--primary">
              Convert a model
            </RouteLink>
            <RouteLink to="analysis" className="button-link button-link--secondary">
              Take a model apart
            </RouteLink>
          </div>

          {/* What the machine running this can actually do, rather than a boast. */}
          <div className="home-chips">
            <span className={`status-chip ${health?.ok ? 'status-chip--available' : 'status-chip--possibility'}`}>
              <span className="status-chip__mark" aria-hidden="true">●</span>
              {health?.ok ? (health.blenderVersion ?? 'Blender ready') : 'Blender not found'}
            </span>
            <span className={`status-chip ${health?.cadSupport ? 'status-chip--available' : 'status-chip--possibility'}`}>
              <span className="status-chip__mark" aria-hidden="true">●</span>
              {health?.cadSupport ? 'STEP and IGES ready' : 'CAD not available'}
            </span>
          </div>
        </div>
      </section>

      <section className="light-section">
        <div className="container">
          <div className="section-heading">
            <p className="eyebrow">How it works</p>
            <h2>Four steps, and the awkward ones are automatic.</h2>
          </div>
          <ol className="workflow home-workflow">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="workflow__index">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="home-step-title">{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="dark-section">
        <div className="container">
          <div className="section-heading">
            <p className="eyebrow">{caps ? `${importable.size} input formats` : 'Formats'}</p>
            <h2>What it reads, and what it writes.</h2>
            <p className="section-heading__intro">
              Read straight off the running backend. CAD and archives are input-only —
              there is no route back from a mesh to parametric CAD.
            </p>
          </div>
          <div className="detail-grid home-formats">
            {FAMILIES.map((family) => (
              <div key={family.label}>
                <h3 className="home-step-title">{family.label}</h3>
                <ul className="feature-list">
                  {family.exts.map((ext) => (
                    <li key={ext}>
                      <span className="home-ext">{ext.slice(1).toUpperCase()}</span>
                      <span className="utility-text">
                        {exportable.has(ext) ? 'in and out' : importable.has(ext) ? 'in only' : 'unavailable'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="utility-text">{family.note}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="light-section">
        <div className="container">
          <div className="section-heading">
            <p className="eyebrow">Details that bite</p>
            <h2>Two things that quietly go wrong everywhere else.</h2>
          </div>
          <div className="detail-grid">
            <div>
              <h3 className="home-step-title">USD is written Y-up</h3>
              <p>
                ARKit and Quick Look require Y-up; Blender authors Z-up. Getting this
                wrong is the usual reason a model lies on its side in AR, and it is
                handled on the way out rather than left to you.
              </p>
            </div>
            <div>
              <h3 className="home-step-title">Broken texture paths are rebound</h3>
              <p>
                Marketplace bundles routinely ship an <code>.mtl</code> full of the
                author's own absolute paths while the images sit in a sibling folder.
                Missing images are matched by exact filename, so a wrong texture is
                never substituted for a missing one.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="dark-section">
        <div className="container">
          <div className="section-heading section-heading--center">
            <h2>Start with a file.</h2>
            <p className="section-heading__intro">
              Nothing is uploaded anywhere but the machine running this backend.
            </p>
          </div>
          <div className="hero-actions hero-actions--final home-cta home-cta--center">
            <RouteLink to="convert" className="button-link button-link--primary">
              Convert a model
            </RouteLink>
            <RouteLink to="settings" className="button-link button-link--secondary">
              Settings
            </RouteLink>
          </div>
        </div>
      </section>
    </>
  )
}
