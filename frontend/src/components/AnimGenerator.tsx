import { useMemo, useState } from 'react'
import type { Clip } from '../api'
import { ALL_WANTED, count, generate, type GenInput, type Wanted } from '../animGen'

/** The switches, in the order they read. Labelled by what they produce. */
const GROUPS: { key: keyof Wanted; label: string; hint: string }[] = [
  { key: 'turns', label: 'Turns', hint: 'Spins, swings and unscrews — anything that rotates' },
  { key: 'travels', label: 'Moves', hint: 'Slides, lifts and removals — anything that travels' },
  { key: 'highlights', label: 'Highlights', hint: 'A swell that picks one part out of the assembly' },
  { key: 'whole', label: 'Whole model', hint: 'A turntable, and an exploded view of every part at once' },
]

/**
 * Build a model's animations from its shape and its part descriptions.
 *
 * The rules are in animGen.ts and none of them asks a model anything; what is
 * here is the count, so a forty-part assembly says "168 animations" before the
 * list is 168 rows longer, and the switches, so a run that only wants the
 * turntable and the exploded view is one click rather than 166 deletions.
 *
 * A run replaces what the last run made and leaves everything else alone: the
 * clips you keyed by hand are yours, and re-running after naming the parts is
 * how you get the better names without losing your own work.
 */
export default function AnimGenerator({ input, pivot, made, onGenerate }: {
  input: GenInput
  /** The model's centre, which the turntable turns about. */
  pivot: readonly [number, number, number]
  /** How many clips the last run left behind, and this one will replace. */
  made: number
  onGenerate: (clips: Clip[]) => void
}) {
  const [wanted, setWanted] = useState<Wanted>(ALL_WANTED)

  // Counting walks every part and runs the word rules over it, which is cheap
  // but not free at five hundred parts on every keystroke elsewhere.
  const total = useMemo(() => count(input, wanted), [input, wanted])
  const nothing = !Object.values(wanted).some(Boolean)

  return (
    <div className="gen">
      <div className="gen-head">
        <span className="gen-title">Generate from the parts</span>
        <span className="gen-count">
          {nothing ? 'nothing selected' : `${total} animation${total === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="gen-picks">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            className={`gen-pick${wanted[g.key] ? ' on' : ''}`}
            title={g.hint}
            aria-pressed={wanted[g.key]}
            onClick={() => setWanted((was) => ({ ...was, [g.key]: !was[g.key] }))}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="gen-acts">
        <button
          className="head-reset"
          disabled={nothing || !input.parts.length}
          onClick={() => onGenerate(generate(input, wanted, pivot).clips)}
        >
          {made ? 'Generate again' : 'Generate'}
        </button>
        <span className="gen-note">
          {made
            ? `replaces the ${made} generated · your own animations stay`
            : `from ${input.parts.length} part${input.parts.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="note">
        Each animation is worked out from the part's own proportions and from
        what the namer said it is — a rod slides along its length, a panel
        swings, a part called a bolt unscrews. Name the parts first and the
        animations come out both better chosen and better named. Every generated
        animation is described in the saved <code>parts.json</code>, so what it
        does survives the export.
      </div>
    </div>
  )
}
