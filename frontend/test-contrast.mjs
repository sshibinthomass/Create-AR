/**
 * The Arvenilo design system is dark-only -- its own README says putting it on a
 * light background makes the near-white type disappear. This app keeps a light
 * theme anyway, which means half the palette in index.css is authored here
 * rather than taken from the DS, and authored colour is exactly the kind that
 * quietly fails a contrast floor.
 *
 * So the floor is asserted rather than trusted. This reads the three token
 * blocks straight out of index.css -- dark, the prefers-color-scheme light
 * block, and the explicit [data-theme=light] override -- and checks every
 * foreground the UI actually lays on every ground it actually lands on.
 *
 * It is the check that fails if someone picks a prettier mint.
 *
 *   node test-contrast.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const css = readFileSync(new URL('./src/index.css', import.meta.url), 'utf8')
// The vendored design system declares the --color-* tokens that the app's own
// tokens chain onto, so it is the bottom of the cascade here as well.
const ds = readFileSync(new URL('./src/ds/arvenilo.css', import.meta.url), 'utf8')

// --- token blocks ------------------------------------------------------------

/**
 * The declarations inside one `{ ... }` block, found by walking braces from the
 * selector rather than matching to the first `}` -- the light theme lives
 * nested inside a media query, so a lazy regex stops one block early.
 */
function block(selector, source = css) {
  const at = source.indexOf(selector)
  assert.notEqual(at, -1, `stylesheet no longer contains ${selector}`)
  let depth = 0
  let start = -1
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') { if (depth === 0) start = i + 1; depth++ }
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i) }
  }
  throw new Error(`unbalanced braces after ${selector}`)
}

/**
 * The `--name: value` declarations in a block, left unresolved. color-mix() and
 * rgba() values are dropped: they are translucent veils and hairlines, which
 * have no single resolved colour to measure and carry no text.
 */
function declarations(source) {
  const out = {}
  for (const [, name, value] of source.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const v = value.trim()
    if (/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(v) || /^var\(--[a-z0-9-]+\)$/.test(v)) out[name] = v
  }
  return out
}

/**
 * Follow `var()` chains to the hex they end at.
 *
 * The chains matter here rather than being an edge case: the app's own tokens
 * are defined once, in the dark :root, as `var(--color-…)` onto the design
 * system's tokens, and a light theme is produced by re-pointing those DS
 * tokens underneath. So --accent is only ever declared once, and which colour
 * it means depends on a --color-signal-mint two blocks further down. Resolving
 * one level inside one block would silently check the dark value twice.
 */
function resolve(declared) {
  const out = {}
  for (const name of Object.keys(declared)) {
    let at = name
    // A cycle would otherwise spin forever; the token count is the bound.
    for (let hop = 0; hop <= Object.keys(declared).length; hop++) {
      const v = declared[at]
      if (!v) break
      if (v.startsWith('#')) { out[name] = v; break }
      at = v.slice(6, -1)
    }
  }
  return out
}

// Dark is the base :root block. Each light theme is that block with its own
// overrides applied on top, which is what the cascade does at runtime.
//
// Light is written twice on purpose -- once for a machine set to light, once
// for an explicit override -- so both copies get checked, and a fix applied to
// only one of them fails here.
const dark = { ...declarations(block(':root {', ds)), ...declarations(block(':root {')) }
const THEMES = {
  dark: resolve(dark),
  'light (system)': resolve({ ...dark, ...declarations(block('@media (prefers-color-scheme: light)')) }),
  'light (chosen)': resolve({ ...dark, ...declarations(block(':root[data-theme="light"]')) }),
}

// --- contrast ----------------------------------------------------------------

function channel(v) {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

// --- what lands on what ------------------------------------------------------

// WCAG 2.2: 4.5 for body text, 3 for large text and for the boundary of a
// control or a graphic that carries meaning on its own.
const TEXT = 4.5
const UI = 3

/** Every ground a floating panel or a page-level surface actually paints. */
const GROUNDS = ['bg', 'panel', 'panel-2']

const PAIRS = [
  // Body copy, and the three greys the interface leans on hardest. --dim
  // carries the drop hint, the format sublabels and the part numbers, which
  // are small and are the first thing to go illegible.
  ...GROUNDS.flatMap((on) => [
    ['text', on, TEXT],
    ['muted', on, TEXT],
    ['dim', on, TEXT],
    // The accent is not decoration here: it labels the selected format, the
    // active part and the edited-value marks, all at 11-13px.
    ['accent', on, TEXT],
  ]),

  // Status colours, on the panel they are chipped onto and on the page ground.
  ['err', 'panel', TEXT],
  ['err', 'bg', TEXT],
  ['err-text', 'panel', TEXT],
  ['err-text', 'bg', TEXT],
  ['warn-text', 'panel', TEXT],
  ['warn-text', 'bg', TEXT],
  ['ok', 'panel', UI],
  ['ok', 'bg', UI],

  // Text laid on a filled accent, where --text would vanish.
  ['on-ok', 'ok', TEXT],

  // A selected keyframe against the hairline that separates it from its track.
  ['key-on', 'key-edge', UI],

  // Every selected state in the app -- the chosen format, the current tab, the
  // active part, the step numbers -- is accent text on --accent-soft, at 11 to
  // 13px. In light that wash is opaque (the design system's own mint-wash), so
  // it is a real ground and gets checked like one. See SOMETIMES below for the
  // dark half of this.
  ['accent', 'accent-soft', TEXT],

  // The viewport grid is deliberately below the UI floor and stays there. It is
  // a reference grid on the model's ground plane, not a graphic carrying
  // meaning of its own -- nobody reads an individual grid line, and a grid with
  // 3:1 against the stage would fight the specimen it exists to sit under.
  // What is worth asserting is that it did not vanish entirely: set equal to
  // the stage and the viewport just looks broken.
  ['grid-section', 'stage-near', 1.2],
  ['grid-section', 'stage-far', 1.2],
]

/**
 * Pairs that only resolve in some themes, and are skipped rather than failed in
 * the others.
 *
 * --accent-soft is the only one so far. In light it is an opaque colour; in dark
 * it is a 14% wash of the accent, which has no single resolved value to measure.
 * Skipping there is the conservative reading anyway: a 14% wash sits far closer
 * to the ground beneath it than to the accent, and that ground is already
 * checked against this same foreground.
 */
const SOMETIMES = new Set(['accent-soft'])

// --- run ---------------------------------------------------------------------

let failures = 0
let checked = 0
let skipped = 0

for (const [theme, palette] of Object.entries(THEMES)) {
  for (const [fg, bg, floor] of PAIRS) {
    const front = palette[fg]
    const back = palette[bg]
    if ((!front && SOMETIMES.has(fg)) || (!back && SOMETIMES.has(bg))) { skipped++; continue }
    assert.ok(front, `${theme}: --${fg} resolves to no colour`)
    assert.ok(back, `${theme}: --${bg} resolves to no colour`)

    const got = ratio(front, back)
    checked++
    if (got < floor) {
      failures++
      console.error(
        `FAIL  ${theme.padEnd(15)} --${fg} on --${bg}` +
          `  ${got.toFixed(2)}:1  (needs ${floor}:1)  ${front} on ${back}`,
      )
    }
  }
}

if (failures) {
  console.error(`\n${failures} of ${checked} pairs below their floor.`)
  process.exit(1)
}
console.log(
  `${checked} contrast pairs pass across ${Object.keys(THEMES).length} themes` +
    `${skipped ? `, ${skipped} skipped as translucent` : ''}.`,
)
