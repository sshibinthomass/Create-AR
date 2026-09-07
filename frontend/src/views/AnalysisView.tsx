import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_OPTIONS, downloadUrl, formatCount, isEdited, NO_EDIT, previewUrl, WHOLE,
  type Capabilities, type Clip, type Handoff, type Health, type NamerSettings,
  type PartDetails, type PartEdit, type PartsDoc, type Pose,
} from '../api'
import {
  copyClip, newClip, pruneClips, restAxes, reverseClip, setKey, splitPose, unpivot,
} from '../animation'
import type { GenInput } from '../animGen'
import { NO_SIZES, type PartSizes } from '../partGraph'
import AgentAsk from '../components/AgentAsk'
import AgentReport from '../components/AgentReport'
import AnimEditor from '../components/AnimEditor'
import AnimGenerator from '../components/AnimGenerator'
import Dropzone from '../components/Dropzone'
import PartDialog from '../components/PartDialog'
import PartEditor from '../components/PartEditor'
import PartPreview from '../components/PartPreview'
import Timeline from '../components/Timeline'
import TransformReadout, { ClipReadout } from '../components/TransformReadout'
import { Player } from '../player'
import { useAgent } from '../useAgent'
import { useConversion } from '../useConversion'
import { useNamer } from '../useNamer'

const ModelViewer = lazy(() => import('../components/ModelViewer'))

/**
 * A length in the model's own units, trimmed to something readable.
 *
 * No unit is printed: what a unit means here is whatever the file said, and
 * exporters disagree -- the same chair arrives in millimetres, centimetres or
 * metres depending on who wrote it. The model's own length is shown beside it
 * so the number has something to be read against.
 */
const trim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))

/** Formats that carry neither per-part names nor materials. */
const NAMELESS = new Set(['.stl', '.ply'])

/**
 * Take a model apart, name and adjust its pieces, save it back out.
 *
 * The model goes through the converter twice: once to GLB, which is what the
 * viewer can read and where the part names come from, and again on save with
 * the names and edits applied. The second pass re-uses the upload the server
 * already has, so only the changes travel.
 */
export default function AnalysisView({
  health, caps, active, settings, onOpenSettings, incoming, onIncomingTaken,
}: {
  health: Health | null
  caps: Capabilities | null
  active: boolean
  /** Owned by the app, edited on the Settings page. Null until they load. */
  settings: NamerSettings | null
  onOpenSettings: () => void
  /** A conversion sent over from the Convert tab, to open straight away. */
  incoming: Handoff | null
  onIncomingTaken: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  // Set instead of `file` when the model arrived from the Convert tab: there is
  // no File to hold, only the job the server already has.
  const [sent, setSent] = useState<Handoff | null>(null)
  const [parts, setParts] = useState<string[]>([])
  const [renames, setRenames] = useState<Record<string, string>>({})
  // What each part is, keyed by its name in the file -- the same key `renames`
  // uses, so both survive a save and come back together in a bundle.
  const [details, setDetails] = useState<Record<string, PartDetails>>({})
  // 'model' saves the converted file alone; 'bundle' zips it with parts.json.
  const [wrap, setWrap] = useState<'model' | 'bundle'>('model')
  const [edits, setEdits] = useState<Record<string, PartEdit>>({})
  // Parts left out of the saved model, by their name in the file. Kept as a
  // list rather than dropped from `parts`: everything else here -- the previews'
  // indices, the names an edit is stored under, the parts document -- is keyed
  // on the file's own set of parts, and deleting is undoable until you save.
  const [removed, setRemoved] = useState<string[]>([])
  const [reach, setReach] = useState(1)
  // Every part's longest side and the model's, from the viewer. What the size
  // floor below is measured against, and what lets the list say which parts it
  // takes in before a single request is spent.
  const [sizes, setSizes] = useState<PartSizes>(NO_SIZES)
  // Leave parts under this fraction of the model's longest side alone, as a
  // percentage. Seeded from the saved setting; the slider decides per run.
  const [floor, setFloor] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  // The part opened full size in its own dialog, by its name in the file.
  const [opened, setOpened] = useState<string | null>(null)
  const [target, setTarget] = useState('.glb')
  const list = useRef<HTMLDivElement>(null)

  // Animation is off until asked for: the clips are kept while it is off, so
  // switching it off is a way of saving the model still, not of losing work.
  const [animate, setAnimate] = useState(false)
  const [clips, setClips] = useState<Clip[]>([])
  const [clipId, setClipId] = useState<string | null>(null)
  // What a keyframe lands on: the marked parts, or the model as one.
  const [subject, setSubject] = useState<'parts' | 'model'>('parts')
  // The model's centre, which a whole-model clip turns about -- measured by
  // the viewer and sent along with the clip so the file pivots there too.
  const [pivot, setPivot] = useState<[number, number, number]>([0, 0, 0])
  const player = useMemo(() => new Player(), [])

  const analysis = useConversion()
  const exported = useConversion()
  const namer = useNamer()
  const agent = useAgent()
  const clearExport = exported.setJob

  // A different model means a different set of parts; nothing carries over.
  const onParts = useCallback((names: string[], span: number,
                               centre: [number, number, number], scale: PartSizes) => {
    setParts(names)
    setReach(span)
    setSizes(scale)
    setPivot(centre)
    setRenames({})
    setDetails({})
    setEdits({})
    agent.setReport(null)
    setRemoved([])
    setSelected([])
    setOpened(null)
    setAnimate(false)
    setClips([])
    setClipId(null)
    setSubject('parts')
    player.stop()
    clearExport(null)
  }, [agent.setReport, clearExport, player])

  const clip = animate ? clips.find((c) => c.id === clipId) ?? null : null
  const wholeModel = clip !== null && subject === 'model'

  // A clip's own length is the clock's; a different clip starts from the top.
  useEffect(() => { player.stop() }, [player, clipId, animate])
  useEffect(() => { player.setDuration(clip?.duration ?? 1) }, [player, clip?.duration])

  const updateClip = useCallback((next: Clip) => {
    setClips((all) => all.map((c) => (c.id === next.id ? next : c)))
  }, [])

  const addClip = useCallback(() => {
    setClips((all) => {
      const made = newClip(`Animation ${all.length + 1}`)
      setClipId(made.id)
      return [...all, made]
    })
  }, [])

  const dropClip = useCallback((id: string) => {
    setClips((all) => {
      const left = all.filter((c) => c.id !== id)
      setClipId((was) => (was === id ? left[0]?.id ?? null : was))
      return left
    })
  }, [])

  /**
   * Copy a clip, and copy it backwards.
   *
   * Taking a product apart and putting it back together are the same movement
   * run in opposite directions, so an assembly animation is a disassembly one
   * duplicated and reversed -- which is the whole reason both are one click.
   */
  const cloneClip = useCallback((id: string, flip: boolean) => {
    setClips((all) => {
      const from = all.find((c) => c.id === id)
      if (!from) return all
      const made = copyClip(
        flip ? reverseClip(from) : from,
        flip ? `${from.name} reversed` : `${from.name} copy`,
      )
      setClipId(made.id)
      const at = all.indexOf(from) + 1
      return [...all.slice(0, at), made, ...all.slice(at)]
    })
  }, [])

  /**
   * Take a generated run's clips, keeping the ones made by hand.
   *
   * A run is meant to be thrown away and repeated -- name the parts, generate,
   * see that the names are better, generate again -- so re-running replaces
   * what the last run left and nothing else. A clip is the generator's if it
   * carries a meta it wrote; one merged out of others is not, because somebody
   * chose to build it.
   */
  const takeGenerated = useCallback((made: Clip[]) => {
    setClips((all) => {
      const mine = all.filter((c) => !c.meta || c.meta.kind === 'merged')
      setClipId(made[0]?.id ?? mine[0]?.id ?? null)
      return [...mine, ...made]
    })
    setAnimate(true)
  }, [])

  /** How many of the clips came from the last run, and a new one would replace. */
  const generated = useMemo(
    () => clips.filter((c) => c.meta && c.meta.kind !== 'merged').length, [clips])

  /** Turning animation on for the first time gives you a clip to start in. */
  const toggleAnimate = useCallback((on: boolean) => {
    setAnimate(on)
    if (on && !clips.length) addClip()
    else if (on && !clipId) setClipId(clips[0].id)
  }, [clips, clipId, addClip])

  // What the marked parts have in common, with a neutral value on any axis they
  // disagree about -- the panel is showing the group, not any one part.
  const shared = useMemo<PartEdit>(() => {
    const marked = selected.map((n) => edits[n] ?? NO_EDIT)
    if (marked.length === 1) return marked[0]
    if (!marked.length) return NO_EDIT
    const axis = (of: (e: PartEdit) => readonly number[], neutral: number) =>
      [0, 1, 2].map((i) =>
        marked.every((e) => of(e)[i] === of(marked[0])[i]) ? of(marked[0])[i] : neutral,
      ) as [number, number, number]
    const same = <T,>(of: (e: PartEdit) => T, neutral: T) =>
      marked.every((e) => of(e) === of(marked[0])) ? of(marked[0]) : neutral
    return {
      move: axis((e) => e.move, 0),
      rotate: axis((e) => e.rotate, 0),
      scale: axis((e) => e.scale, 1),
      material: same((e) => e.material, ''),
      color: same((e) => e.color, NO_EDIT.color),
      recolor: same((e) => e.recolor, false),
      opacity: same((e) => e.opacity, NO_EDIT.opacity),
      roughness: same((e) => e.roughness, NO_EDIT.roughness),
      metalness: same((e) => e.metalness, NO_EDIT.metalness),
    }
  }, [selected, edits])

  /**
   * Write a change from the panel onto every marked part.
   *
   * Only the fields the user actually moved are copied across: the panel shows
   * a neutral value wherever the group disagrees, so assigning the whole edit
   * would quietly flatten the parts that differ back to nothing.
   */
  const applyToMarked = useCallback((next: PartEdit) => {
    setEdits((all) => {
      const copy = { ...all }
      for (const name of selected) {
        const own = copy[name] ?? NO_EDIT
        const kept = (to: keyof Pick<PartEdit, 'move' | 'rotate' | 'scale'>) =>
          next[to].map((v, i) => (v === shared[to][i] ? own[to][i] : v)) as
            [number, number, number]
        // Every scalar follows the same rule as the axes: a value the panel is
        // still showing as the group's own is one the user has not touched.
        const held = <
          K extends 'material' | 'color' | 'recolor' | 'opacity' | 'roughness' | 'metalness',
        >(to: K) => (next[to] === shared[to] ? own[to] : next[to])
        copy[name] = {
          move: kept('move'),
          rotate: kept('rotate'),
          scale: kept('scale'),
          material: held('material'),
          color: held('color'),
          recolor: held('recolor'),
          opacity: held('opacity'),
          roughness: held('roughness'),
          metalness: held('metalness'),
        }
      }
      return copy
    })
  }, [selected, shared])

  /**
   * Undo a change on every marked part: one number, one channel, or the lot.
   *
   * Not routed through `applyToMarked`. That copies across only what differs
   * from what the panel is showing, so putting an axis back to a value the
   * panel already reads as the group's own -- which is exactly what an undo
   * does where the parts disagree -- would be taken for no change at all.
   */
  const resetMarked = useCallback((key: keyof Pose | null, axis: number | null) => {
    setEdits((all) => {
      const copy = { ...all }
      for (const name of selected) {
        const own = copy[name]
        if (!own) continue
        if (key === null) delete copy[name]
        else copy[name] = { ...own, [key]: restAxes(own, key, axis) }
      }
      return copy
    })
  }, [selected])

  /** Plain click replaces the marks; shift or ctrl/cmd adds to or drops from them. */
  const mark = useCallback((name: string | null, additive: boolean) => {
    // Picking a part is picking what to animate, too.
    if (name !== null) setSubject('parts')
    setSelected((was) => {
      if (name === null) return additive ? was : []
      if (!additive) return [name]
      return was.includes(name) ? was.filter((n) => n !== name) : [...was, name]
    })
  }, [])

  /** Point the keyframes at the model as one. Nothing is marked while they are. */
  const pickWhole = useCallback(() => {
    setSubject('model')
    setSelected([])
  }, [])

  const gone = useMemo(() => new Set(removed), [removed])
  // The parts still in the model: what the timeline offers to mark, since a
  // part left out of the save has nothing to animate.
  const living = useMemo(() => parts.filter((n) => !gone.has(n)), [parts, gone])

  /**
   * Everything the animation rules read, with the deleted parts left out.
   *
   * The geometry arrives indexed by the model's full set of parts, so dropping
   * a part means dropping its box and its centre with it -- a run keyed on
   * mismatched indices would animate the wrong things and look, at a glance,
   * as though it had worked.
   */
  const genInput = useMemo<GenInput>(() => {
    const keep = parts.map((n, i) => (gone.has(n) ? -1 : i)).filter((i) => i >= 0)
    const pick = <T,>(all: readonly T[]) => keep.map((i) => all[i])
    return {
      parts: keep.map((i) => parts[i]),
      geometry: {
        boxes: pick(sizes.boxes),
        centres: pick(sizes.centres),
        spins: pick(sizes.spins),
        // The whole model's, deleted parts included: how big the thing is, and
        // which way is outward, are not changed by leaving a bolt out of it.
        extents: sizes.extents,
        middle: sizes.middle,
      },
      labels: renames,
      details,
    }
  }, [parts, gone, sizes, renames, details])

  /** Leave a part out of the saved model. Its name and description stay put. */
  const drop = useCallback((name: string) => {
    setRemoved((was) => (was.includes(name) ? was : [...was, name]))
    // A part that is not in the model cannot be the one you are editing.
    setSelected((was) => was.filter((n) => n !== name))
  }, [])

  const restore = useCallback((name: string) => {
    setRemoved((was) => was.filter((n) => n !== name))
  }, [])

  /** Apply a name and a description typed in the dialog, both at once. */
  const describePart = useCallback((part: string, name: string, facts: PartDetails) => {
    setRenames((was) => {
      const copy = { ...was }
      // A name that matches the file's own is not a rename -- the same rule the
      // list's own name field follows.
      if (!name || name === part) delete copy[part]
      else copy[part] = name
      return copy
    })
    setDetails((was) => {
      const copy = { ...was }
      if (Object.keys(facts).length) copy[part] = facts
      else delete copy[part]
      return copy
    })
  }, [])

  // A part picked in the viewer has to be findable in a list that can be
  // hundreds of rows long. The list is scrolled directly rather than through
  // scrollIntoView, which would drag the whole page along with it.
  useEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('.part-row.on')
    if (!box || !row) return
    const top = row.offsetTop - box.offsetTop
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = top - (box.clientHeight - row.offsetHeight) / 2
    }
  }, [selected])

  /**
   * Put a bundle's own document back on the parts it describes.
   *
   * The model inside a bundle was written with the names already applied, so a
   * part's name in the file usually *is* the document's `name`; `originalName`
   * catches a bundle whose model was exported to a format that cannot carry
   * names at all, and the index is the last resort. Runs once per set of parts,
   * and only fills what the user has not already changed.
   */
  const doc = analysis.job?.partDoc ?? null
  const applied = useRef<PartsDoc | null>(null)
  useEffect(() => {
    if (!doc || !parts.length || applied.current === doc) return
    applied.current = doc
    const byName = new Map<string, PartsDoc['parts'][number]>()
    for (const entry of doc.parts) {
      if (entry.name) byName.set(entry.name, entry)
      if (entry.originalName) byName.set(entry.originalName, entry)
    }
    const names: Record<string, string> = {}
    const notes: Record<string, PartDetails> = {}
    parts.forEach((part, at) => {
      const entry = byName.get(part) ?? doc.parts.find((e) => e.index === at)
      if (!entry) return
      if (entry.name && entry.name !== part) names[part] = entry.name
      if (Object.keys(entry.details).length) notes[part] = entry.details
    })
    setRenames((was) => ({ ...names, ...was }))
    setDetails((was) => ({ ...notes, ...was }))
  }, [doc, parts])

  /**
   * The clips as they will be saved: only while animation is on, without the
   * parts that are being deleted, and with the pivot on the whole-model track.
   */
  const animated = useMemo(() => (animate
    ? pruneClips(clips, (t) => t === WHOLE || !gone.has(t)).map((c) => ({
      ...c,
      tracks: c.tracks.map((t) => (t.target === WHOLE ? { ...t, pivot } : t)),
    }))
    : []), [animate, clips, gone, pivot])
  const animating = animated.length > 0
  const keyCount = animated.reduce(
    (n, c) => n + c.tracks.reduce((m, t) => m + t.keys.length, 0), 0)

  // With animation to save, only the formats that can hold it are offered.
  // OBJ, STL and PLY describe a single still and would drop it without a word.
  const outputs = useMemo(
    () => (caps?.formats ?? []).filter((f) => f.can_export && (!animating || f.can_animate)),
    [caps, animating],
  )
  useEffect(() => {
    if (animating && !outputs.some((f) => f.ext === target)) setTarget('.glb')
  }, [animating, outputs, target])

  const stats = analysis.job?.resultStats ?? null
  const preview = analysis.job?.status === 'done' && analysis.job.hasPreview
    ? previewUrl(analysis.job.id)
    : null
  // One part at a time in the card: with several marked the panel below the
  // list is already showing what they have in common, and stacking descriptions
  // would bury the model.
  const shown = useMemo(() => {
    if (selected.length !== 1) return null
    const part = selected[0]
    const at = parts.indexOf(part)
    if (at < 0) return null
    return { at, name: renames[part] ?? part, details: details[part] ?? {} }
  }, [selected, parts, renames, details])

  const renamed = Object.keys(renames).length
  const adjusted = Object.values(edits).filter(isEdited).length
  // Parts with a keyframe in the clip being worked on, for the mark in the list.
  const keyed = useMemo(() => new Set(clip?.tracks.map((t) => t.target) ?? []), [clip])
  const labelOf = useCallback(
    (t: string) => (t === WHOLE ? 'Whole model' : renames[t] ?? t), [renames])
  // What the animation editor poses: the model as one, or the marked parts.
  const animTargets = useMemo(
    () => (subject === 'model' ? [WHOLE] : selected.filter((n) => !gone.has(n))),
    [subject, selected, gone])

  /**
   * Mark every part still in the model, or clear the marks.
   *
   * Moving a model as one is marking all of its parts and dragging them
   * together -- each keeps its own edit, so the save needs nothing new. The
   * marks are what the animation subject follows, so this picks the parts
   * rather than the model-as-one track, exactly as clicking a part does.
   */
  const markAll = useCallback((on: boolean) => {
    setSubject('parts')
    setSelected(on ? living : [])
  }, [living])
  const allMarked = !wholeModel && living.length > 0 && selected.length === living.length

  // What the figures over the model are of: the parts a keyframe would land on
  // while a clip is open, and the marked parts otherwise -- which is in both
  // cases whatever a gizmo drag in the viewer would move.
  const readTargets = clip ? animTargets : selected
  const readTitle = readTargets.length === 1
    ? labelOf(readTargets[0]) || 'Unnamed part'
    : `${readTargets.length} parts`

  /**
   * A gizmo drag, read back from the viewer as one combined delta per part.
   *
   * With a clip open it is a keyframe at the playhead, not an edit: the clip's
   * part of the pose is peeled off the static edit for a part, and turned into
   * a pose about the pivot for the whole model.
   */
  const onGizmo = useCallback((changes: Record<string, PartEdit>) => {
    if (!clip) {
      setEdits((e) => ({ ...e, ...changes }))
      return
    }
    const time = player.time
    updateClip(Object.entries(changes).reduce((acc, [name, combined]) => setKey(
      acc, name, time,
      name === WHOLE ? unpivot(combined, pivot) : splitPose(combined, edits[name] ?? NO_EDIT),
    ), clip))
  }, [clip, player, pivot, edits, updateClip])


  // Everything held about the model that is being replaced. Shared by the two
  // ways a model arrives: dropped here, or sent over from the Convert tab.
  const forget = useCallback(() => {
    setParts([])
    setRenames({})
    setDetails({})
    setEdits({})
    setRemoved([])
    setSelected([])
    setOpened(null)
    setAnimate(false)
    setClips([])
    setClipId(null)
    player.stop()
    exported.setJob(null)
  }, [player, exported])

  // A conversion arriving from the Convert tab opens itself: the user pressed
  // the button that means "take this apart", so making them press another one
  // here would be asking the same question twice. Taken once and cleared, so a
  // later tab switch does not re-run it.
  const takeIncoming = analysis.startFrom
  useEffect(() => {
    if (!incoming) return
    onIncomingTaken()
    setFile(null)
    setSent(incoming)
    forget()
    analysis.setError(null)
    takeIncoming(incoming.jobId, '.glb', incoming.options)
    // `forget` and the setters are stable; re-running on anything but a new
    // hand-off would restart the analysis under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming])

  function analyse() {
    if (file) {
      forget()
      analysis.start(file, '.glb', DEFAULT_OPTIONS)
    } else if (sent) {
      forget()
      analysis.startFrom(sent.jobId, '.glb', sent.options)
    }
  }

  /**
   * Hand every part to the model and write back what it says they are.
   *
   * The answers arrive chunk by chunk and are folded straight into `renames`,
   * so they show up in the list as they land and every row keeps its own undo.
   * A name that matches the file's own is not a rename, the same rule the
   * name field itself follows.
   */
  const fold = useCallback((
    found: Record<string, string>, told: Record<string, PartDetails>,
  ) => {
    setRenames((was) => {
      const copy = { ...was }
      for (const [original, name] of Object.entries(found)) {
        if (name === original) delete copy[original]
        else copy[original] = name
      }
      return copy
    })
    if (Object.keys(told).length) setDetails((was) => ({ ...was, ...told }))
  }, [])

  // The saved setting is where the slider starts; after that the slider is the
  // one that decides, per run, so a later settings fetch must not drag it back.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !settings) return
    seeded.current = true
    setFloor(settings.min_part_size)
  }, [settings])

  /**
   * Which parts the namer would leave alone as things stand.
   *
   * Worked out in the browser from what the viewer measured, so the list can
   * show it as the slider moves rather than after a run has been paid for. The
   * two reasons are kept apart because they are not the same kind of thing: an
   * artefact has no volume and no view can identify it, while a part under the
   * floor is a real component the user has chosen not to spend a request on.
   */
  const { artefacts, under } = useMemo(() => {
    const artefacts = new Set<number>()
    const under = new Set<number>()
    const limit = floor > 0 ? (sizes.model * floor) / 100 : 0
    parts.forEach((_, i) => {
      if ((sizes.faces[i] ?? 2) <= 1) artefacts.add(i)
      else if (limit > 0 && (sizes.parts[i] ?? Infinity) < limit) under.add(i)
    })
    return { artefacts, under }
  }, [parts, sizes, floor])

  const analysed = parts.length - artefacts.size - under.size

  // Either namer counts as busy; the buttons and the bar do not care which.
  const naming = namer.busy || agent.busy
  const progressOf = namer.busy
    ? (namer.total ? namer.done / namer.total : 0)
    : (agent.total ? agent.done / agent.total : 0)

  function autoName() {
    if (!preview || !settings) return
    // Both namers write back the same way; they differ in how they arrive at
    // the answers. See useAgent.ts and backend/app/agent.py for the difference.
    if (settings.agent) agent.run(preview, parts, floor, fold)
    else namer.run(preview, parts, settings, fold)
  }

  /** Every part, as the document records it: its old name, its new one, and what it is.
   *
   * Deleted parts are left out, and the rest are numbered from scratch: the
   * index describes the model the document is written beside, not the file that
   * was opened. */
  const described = useMemo(() => parts
    .filter((name) => !gone.has(name))
    .map((name, index) => ({
      index,
      originalName: name,
      name: renames[name] ?? name,
      details: details[name] ?? {},
    })), [parts, renames, details, gone])

  function save() {
    if (!analysis.job) return
    // A rename or an edit aimed at a part that is being deleted has nothing to
    // land on, and sending it would have the job warn about a part the user
    // deliberately took out.
    const kept = <T,>(all: Record<string, T>) =>
      Object.fromEntries(Object.entries(all).filter(([name]) => !gone.has(name)))
    exported.startFrom(analysis.job.id, target, {
      ...DEFAULT_OPTIONS,
      archive_entry: analysis.job.archiveEntry ?? '',
      renames: kept(renames),
      edits: kept(edits),
      remove: removed,
      bundle: wrap === 'bundle',
      part_details: wrap === 'bundle' ? described : undefined,
      clips: animating ? animated : undefined,
    })
  }

  return (
    <div className="analysis">
      {/* Loading the model spans the width; the parts and the viewer share the
          room below it, which is where the work actually happens. */}
      <section className="card source">
        <div className="card-head"><h2>Model to inspect</h2></div>
        <div className="card-body source-body">
          {sent ? (
            <div className="file-chip">
              <span className="ext">
                {sent.name.slice(sent.name.lastIndexOf('.') + 1).toUpperCase()}
              </span>
              <div className="meta">
                <div className="name" title={sent.name}>{sent.name}</div>
                <div className="sub">converted on the Convert tab</div>
              </div>
              <button
                className="x"
                onClick={() => { setSent(null); forget(); analysis.setJob(null) }}
                aria-label="Remove file"
              >
                &times;
              </button>
            </div>
          ) : (
            <Dropzone
              file={file}
              accept={caps?.inputs ?? []}
              maxBytes={health?.maxUploadBytes ?? 512 * 1024 * 1024}
              onSelect={(f) => { setFile(f); analysis.setError(null) }}
              onReject={analysis.setError}
            />
          )}
          <div className="note">
            Every part the model was authored with is pulled outward from the
            centre of the assembly. Click a part — in the viewer or in the list
            — to see its name and pick it out, and shift-click to mark several
            and move them together. Models exported as one merged mesh have
            nothing to separate.
          </div>
          <button
            className="go"
            disabled={(!file && !sent) || !health?.ok || analysis.busy}
            onClick={analyse}
          >
            {analysis.uploading
              ? `Uploading ${analysis.uploadPct}%`
              : analysis.busy
                ? 'Preparing…'
                : sent ? 'Analyse again' : 'Analyse model'}
          </button>
        </div>
        {analysis.job?.status === 'done' && (
          <div className="stats">
            <div className="stat"><div className="k">Parts</div><div className="v">{formatCount(parts.length - removed.length)}</div></div>
            <div className="stat"><div className="k">Meshes</div><div className="v">{formatCount(stats?.meshes)}</div></div>
            <div className="stat"><div className="k">Triangles</div><div className="v">{formatCount(stats?.triangles)}</div></div>
            <div className="stat"><div className="k">Materials</div><div className="v">{formatCount(stats?.materials)}</div></div>
          </div>
        )}
      </section>

      {analysis.error && <div className="error-box source">{analysis.error}</div>}

      <div className="col">
        {parts.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Parts</h2>
              {(renamed > 0 || adjusted > 0 || removed.length > 0 || selected.length > 1) && (
                <span className="head-note">
                  {[selected.length > 1 && `${selected.length} marked`,
                    renamed && `${renamed} renamed`,
                    adjusted && `${adjusted} edited`,
                    removed.length && `${removed.length} removed`]
                    .filter(Boolean).join(' · ')}
                </span>
              )}
              {renamed > 0 && (
                <button
                  className="head-reset"
                  title="Put every part's name back to the one in the file"
                  onClick={() => setRenames({})}
                >
                  Reset names
                </button>
              )}
              {adjusted > 0 && (
                <button
                  className="head-reset"
                  title="Undo every move, rotation, scale and material"
                  onClick={() => setEdits({})}
                >
                  Reset edits
                </button>
              )}
              {removed.length > 0 && (
                <button
                  className="head-reset"
                  title="Put every deleted part back into the model"
                  onClick={() => setRemoved([])}
                >
                  Restore all
                </button>
              )}
            </div>
            <div className="name-bar">
              <button
                className="go name-go"
                disabled={!preview || !settings?.configured || naming || analysis.busy}
                onClick={autoName}
              >
                {namer.busy
                  ? `${namer.step}… ${namer.done}/${namer.total}`
                  : agent.busy
                    ? `${agent.note}… ${agent.done}/${agent.total}`
                    : settings?.agent ? 'Name parts with the agent' : 'Name parts with AI'}
              </button>
              {naming ? (
                <button
                  className="head-reset"
                  onClick={settings?.agent ? agent.stop : namer.stop}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="head-reset"
                  title="Provider, batching and the instructions"
                  onClick={onOpenSettings}
                >
                  Settings
                </button>
              )}
            </div>

            {settings?.agent && parts.length > 1 && (
              <div className="size-floor">
                <div className="size-floor-row">
                  <label htmlFor="pf-floor">Skip parts under</label>
                  <input
                    id="pf-floor" type="range" min={0} max={10} step={0.25}
                    value={floor} disabled={naming}
                    onChange={(e) => setFloor(Number(e.target.value))}
                  />
                  <output htmlFor="pf-floor">
                    {floor === 0 ? 'nothing' : `${floor}%`}
                  </output>
                </div>
                <div className="size-floor-read">
                  {floor > 0 && (
                    <>
                      Under {trim((sizes.model * floor) / 100)} on the longest
                      side, where the whole model is {trim(sizes.model)}.{' '}
                    </>
                  )}
                  <strong>{analysed}</strong> of {parts.length} parts analysed
                  {under.size > 0 && `, ${under.size} left alone`}
                  {artefacts.size > 0
                    && `, ${artefacts.size} artefact${artefacts.size > 1 ? 's' : ''}`}.
                  {' '}Excluded parts keep the name the file gave them.
                </div>
              </div>
            )}

            {naming && (
              <div className="name-prog">
                <div className={`bar${progressOf ? '' : ' indet'}`}>
                  <i style={{ width: `${progressOf * 100}%` }} />
                </div>
                {agent.busy && agent.subject && (
                  <div className="note" style={{ marginTop: 6 }}>
                    Reading this as {agent.subject}
                  </div>
                )}
              </div>
            )}

            {agent.asking && (
              <AgentAsk
                pending={agent.asking}
                onAnswer={agent.answer}
                onStop={agent.stop}
              />
            )}

            {agent.report && !naming && (
              <AgentReport
                report={agent.report}
                onDismiss={() => agent.setReport(null)}
                onOpenPart={(at) => {
                  const part = parts[at]
                  if (!part) return
                  setSelected([part])
                  setOpened(part)
                }}
              />
            )}

            {settings && !settings.configured && !naming && (
              <div className="name-prog">
                <div className="note" style={{ marginTop: 0 }}>
                  Naming needs a provider and an API key. Pick one in{' '}
                  <button className="link" onClick={onOpenSettings}>Settings</button> —
                  they are kept on the server, not in the browser.
                </div>
              </div>
            )}

            {(namer.error || agent.error) && (
              <div className="name-prog">
                <div className="error-box">{namer.error || agent.error}</div>
              </div>
            )}

            <div className="parts" ref={list}>
              {parts.map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className={`part-row${selected.includes(name) ? ' on' : ''}${
                    gone.has(name) ? ' gone' : ''}${
                    artefacts.has(i) ? ' artefact' : under.has(i) ? ' under' : ''}`}
                  title={artefacts.has(i)
                    ? 'One face, no volume: a modelling artefact. Always left alone.'
                    : under.has(i)
                      ? 'Below the size floor, so it will keep its file name.'
                      : undefined}
                  onClick={(e) => {
                    if (gone.has(name)) return
                    mark(name, e.shiftKey || e.ctrlKey || e.metaKey)
                  }}
                >
                  <span className="part-n">{i + 1}</span>
                  <input
                    value={renames[name] ?? name}
                    disabled={gone.has(name)}
                    aria-label={`Name of part ${name || i + 1}`}
                    onChange={(e) => {
                      const next = e.target.value
                      setRenames((r) => {
                        const copy = { ...r }
                        if (next === name) delete copy[name]
                        else copy[name] = next
                        return copy
                      })
                    }}
                  />
                  {isEdited(edits[name]) && !gone.has(name) && (
                    <span className="part-edited" title="This part has been moved, resized or restyled">✎</span>
                  )}
                  {keyed.has(name) && !gone.has(name) && (
                    <span className="part-keyed" title="This part has keyframes in the current animation">◆</span>
                  )}
                  {renames[name] !== undefined && !gone.has(name) && (
                    <button
                      className="part-undo"
                      title={`Restore "${name}"`}
                      onClick={() => setRenames((r) => {
                        const copy = { ...r }
                        delete copy[name]
                        return copy
                      })}
                    >
                      ↺
                    </button>
                  )}
                  {gone.has(name) ? (
                    <button
                      className="part-restore"
                      title="Put this part back into the model"
                      onClick={(e) => { e.stopPropagation(); restore(name) }}
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      {preview && (
                        <button
                          className="part-open"
                          title="Open this part on its own"
                          onClick={(e) => { e.stopPropagation(); setSelected([name]); setOpened(name) }}
                        >
                          ⤢
                        </button>
                      )}
                      <button
                        className="part-drop"
                        title="Leave this part out of the saved model"
                        onClick={(e) => { e.stopPropagation(); drop(name) }}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {/* With a clip open the sliders that pose a part live in the
                animation card, and pose it at the playhead instead. */}
            {selected.length > 0 && !clip && (
              <PartEditor
                names={selected.map((n) => renames[n] ?? n)}
                value={shared}
                extent={reach}
                onChange={applyToMarked}
                onReset={resetMarked}
              />
            )}

            <div className="card-body">
              <div className="opt-row">
                <label>Export</label>
                <div className="ctl wrap-pick">
                  <button
                    className={`wrap-opt${wrap === 'model' ? ' sel' : ''}`}
                    onClick={() => setWrap('model')}
                  >
                    Model only
                  </button>
                  <button
                    className={`wrap-opt${wrap === 'bundle' ? ' sel' : ''}`}
                    onClick={() => setWrap('bundle')}
                  >
                    Model + details
                  </button>
                </div>
              </div>

              <div className="opt-row">
                <label htmlFor="an-target">Save as</label>
                <div className="ctl">
                  <select id="an-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                    {outputs.map((f) => (
                      <option key={f.ext} value={f.ext}>
                        {f.ext.slice(1).toUpperCase()} — {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {wrap === 'bundle' && (
                <div className="note">
                  A ZIP holding the {target.slice(1).toUpperCase()} and a{' '}
                  <code>parts.json</code> describing every part. Drop that ZIP
                  back in and the app recognises its own document, putting the
                  names and descriptions back on the parts they belong to.
                  {described.every((d) => !Object.keys(d.details).length) && (
                    <> Nothing has been described yet — the document will carry
                    the names alone until you run the namer with descriptions on.</>
                  )}
                </div>
              )}

              {NAMELESS.has(target) && (
                <div className="note">
                  {target.slice(1).toUpperCase()} stores a single unnamed, unshaded
                  mesh, so the names and materials are lost on the way out — though
                  the moves, rotations and scales still apply. GLB, USD, FBX and OBJ
                  all keep the lot.
                </div>
              )}

              {animating && (
                <div className="note">
                  Saving with {animated.length === 1
                    ? `the animation “${animated[0].name}”`
                    : `${animated.length} animations`} — {keyCount} keyframe{keyCount === 1 ? '' : 's'} in
                  all. Only formats that can hold animation are offered.{' '}
                  {['.glb', '.gltf'].includes(target)
                    ? 'glTF keeps each as a named clip, which a viewer lets you pick and play.'
                    : target === '.fbx'
                      ? 'FBX gets one take, the clips playing one after another.'
                      : 'This format has one timeline, so the clips play one after another.'}
                </div>
              )}

              {animate && !animating && (
                <div className="note">
                  Animation is on but nothing has a keyframe yet, so the model
                  saves as a still.
                </div>
              )}

              {!animate && clips.some((c) => c.tracks.length) && (
                <div className="note">
                  Animation is off, so the model saves without the{' '}
                  {clips.length === 1 ? 'animation' : `${clips.length} animations`} you
                  made. Turn it back on to keep them.
                </div>
              )}

              {exported.error && <div className="error-box" style={{ marginTop: 12 }}>{exported.error}</div>}
              {exported.job?.status === 'error' && (
                <div className="error-box" style={{ marginTop: 12 }}>{exported.job.error}</div>
              )}
              {exported.job?.status === 'done' && exported.job.warnings.length > 0 && (
                <div className="warn-box">
                  {exported.job.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}

              <button
                className="go"
                style={{ marginTop: 12 }}
                disabled={analysis.busy || exported.busy}
                onClick={save}
              >
                {exported.busy
                  ? `Saving… ${exported.job?.progress ?? 0}%`
                  : wrap === 'bundle'
                    ? `Save ${target.slice(1).toUpperCase()} + details as ZIP`
                    : animating
                      ? `Save animated ${target.slice(1).toUpperCase()}`
                      : `Save as ${target.slice(1).toUpperCase()}`}
              </button>

              {exported.job?.status === 'done' && (
                <a className="dl" href={downloadUrl(exported.job.id)} download>
                  Download {exported.job.downloadName}
                </a>
              )}
            </div>
          </section>
        )}

        {parts.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Animation</h2>
              {!animate && clips.some((c) => c.tracks.length) && (
                <span className="head-note off">
                  off · {clips.length} kept
                </span>
              )}
              {animate && clips.length > 0 && (
                <span className="head-note">{animating ? `${keyCount} keyframes` : 'no keyframes yet'}</span>
              )}
              <label className="switch head-switch" title={animate ? 'Turn animation off' : 'Turn animation on'}>
                <input
                  type="checkbox" checked={animate}
                  aria-label="Animate the model"
                  onChange={(e) => toggleAnimate(e.target.checked)}
                />
                <span />
              </label>
            </div>

            {animate && (
              <>
                <AnimGenerator
                  input={genInput}
                  pivot={pivot}
                  made={generated}
                  onGenerate={takeGenerated}
                />

                <div className="clips">
                  {clips.map((c) => {
                    const keys = c.tracks.reduce((n, t) => n + t.keys.length, 0)
                    return (
                      <div
                        key={c.id}
                        className={`clip-row${c.id === clipId ? ' on' : ''}`}
                        title={c.meta?.summary}
                        onClick={() => setClipId(c.id)}
                      >
                        <span className={`clip-dot${c.meta ? ' made' : ''}`} />
                        <input
                          value={c.name}
                          aria-label="Name of the animation"
                          onChange={(e) => updateClip({ ...c, name: e.target.value })}
                          onFocus={() => setClipId(c.id)}
                        />
                        <span className="clip-len">
                          {c.duration}s · {keys ? `${keys} key${keys === 1 ? '' : 's'}` : 'empty'}
                        </span>
                        <button
                          className="clip-act"
                          disabled={!keys}
                          title="Copy this animation running backwards — a teardown reversed is the assembly"
                          onClick={(e) => { e.stopPropagation(); cloneClip(c.id, true) }}
                        >
                          Reverse
                        </button>
                        <button
                          className="clip-act"
                          disabled={!keys}
                          title="Make a copy of this animation to vary"
                          onClick={(e) => { e.stopPropagation(); cloneClip(c.id, false) }}
                        >
                          Copy
                        </button>
                        <button
                          className="part-drop"
                          title="Delete this animation"
                          onClick={(e) => { e.stopPropagation(); dropClip(c.id) }}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                  <button className="clip-add" onClick={addClip}>+ Add animation</button>
                </div>

                {clip && (
                  <>
                    <div className="anim-subject">
                      <label>Animate</label>
                      <div className="ctl wrap-pick">
                        <button
                          className={`wrap-opt${subject === 'parts' ? ' sel' : ''}`}
                          onClick={() => setSubject('parts')}
                        >
                          Marked parts
                        </button>
                        <button
                          className={`wrap-opt${subject === 'model' ? ' sel' : ''}`}
                          onClick={pickWhole}
                        >
                          Whole model
                        </button>
                      </div>
                    </div>

                    <AnimEditor
                      clip={clip}
                      targets={animTargets}
                      label={labelOf}
                      extent={reach}
                      player={player}
                      onClip={updateClip}
                    />
                  </>
                )}

                {!clip && (
                  <div className="card-body">
                    <div className="note" style={{ marginTop: 0 }}>
                      Add an animation to start keying poses into it.
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>

      <div className="col">
        <section className="card viewer-card">
          <Suspense fallback={<div className="viewer"><div className="viewer-empty">Loading viewer…</div></div>}>
            <ModelViewer
              key={preview ?? 'empty'}
              url={preview}
              explodeOpen
              labels={renames}
              edits={edits}
              hidden={removed}
              selected={selected}
              onSelect={mark}
              onEdit={onGizmo}
              onParts={onParts}
              clip={clip}
              player={player}
              wholeModel={wholeModel}
              active={active}
              animate={animate}
              // Only once the model has parts: there is nothing to animate
              // before that, and the button would be a dead end.
              onAnimate={parts.length > 0 ? toggleAnimate : undefined}
              allMarked={allMarked}
              // Nothing to mark until the model has turned out to have parts.
              onMarkAll={living.length > 0 ? markAll : undefined}
              dock={clip && (
                <Timeline
                  clip={clip}
                  clips={clips}
                  player={player}
                  targets={animTargets}
                  parts={living}
                  selected={selected}
                  subject={subject}
                  label={labelOf}
                  onClip={updateClip}
                  onPickClip={setClipId}
                  onAddClip={addClip}
                  onPick={(t, additive) => {
                    if (t === WHOLE) pickWhole()
                    else mark(t, additive)
                  }}
                  onSubject={(next) => {
                    if (next === 'model') pickWhole()
                    else setSubject('parts')
                  }}
                />
              )}
              placeholder={
                analysis.job?.status === 'error'
                  ? 'That model could not be read — see the message on the left.'
                  : analysis.busy
                    ? 'Preparing the model…'
                    : 'Upload a model to take it apart.'
              }
            >
              {/* Both panels live inside the viewer, so filling the window
                  carries them along instead of burying them under it. */}

              {/* Down the right: where the marked parts have been moved to,
                  and the one that is marked on its own under it -- a box
                  around a trim piece says where it is, not what it is. The
                  figures come first, so a stage with no room for both keeps
                  them and lets the thumbnail go rather than the other way
                  round. */}
              {(readTargets.length > 0 || (shown && preview)) && (
                <div className="viewer-side">
                  {readTargets.length > 0 && (clip
                    ? (
                      <ClipReadout
                        clip={clip}
                        targets={readTargets}
                        title={readTitle}
                        extent={reach}
                        player={player}
                        onClip={updateClip}
                      />
                    ) : (
                      <TransformReadout
                        title={readTitle}
                        poses={readTargets.map((n) => edits[n] ?? NO_EDIT)}
                        extent={reach}
                        onReset={resetMarked}
                      />
                    ))}

                  {shown && preview && (
                    <PartPreview
                      url={preview}
                      index={shown.at}
                      name={shown.name}
                      edit={edits[selected[0]]}
                      onOpen={() => setOpened(selected[0])}
                    />
                  )}
                </div>
              )}

              {/* What the selected part is, over the model rather than beside
                  it: the name is already on the part, and this is the rest. */}
              {shown && (
                <aside className="part-card">
                  <div className="part-card-head">
                    <h3>{shown.name}</h3>
                    {preview && (
                      <button
                        className="part-card-open"
                        title="Open this part on its own, to name, describe and edit it"
                        onClick={() => setOpened(selected[0])}
                      >
                        ⤢
                      </button>
                    )}
                    <button
                      className="part-card-x"
                      title="Hide these details"
                      onClick={() => setSelected([])}
                    >
                      ×
                    </button>
                  </div>
                  {Object.keys(shown.details).length ? (
                    <dl className="part-facts">
                      {Object.entries(shown.details).map(([label, text]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{text}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="part-card-empty">
                      Nothing is recorded about this part yet. Open the part on
                      its own to write a description or ask the model for one,
                      run <b>Name parts with AI</b> over the lot, or open a
                      bundle that already has them.
                    </p>
                  )}
                </aside>
              )}
            </ModelViewer>
          </Suspense>

          {(analysis.busy || analysis.uploading) && (
            <div className="card-body">
              <div className="prog-row">
                <span>{analysis.uploading ? 'Uploading' : (analysis.job?.step ?? 'Working')}</span>
                <span>{analysis.uploading ? `${analysis.uploadPct}%` : `${analysis.job?.progress ?? 0}%`}</span>
              </div>
              <div className={`bar${!analysis.uploading && analysis.job?.status === 'queued' ? ' indet' : ''}`}>
                <i style={{ width: `${analysis.uploading ? analysis.uploadPct : (analysis.job?.progress ?? 0)}%` }} />
              </div>
            </div>
          )}
        </section>
      </div>

      {opened !== null && preview && parts.includes(opened) && (
        <PartDialog
          url={preview}
          index={parts.indexOf(opened)}
          total={parts.length}
          originalName={opened}
          name={renames[opened] ?? opened}
          details={details[opened] ?? {}}
          edit={edits[opened]}
          extent={reach}
          settings={settings}
          taken={parts.filter((n) => n !== opened).map((n) => renames[n] ?? n)}
          removed={gone.has(opened)}
          onSave={(name, facts) => describePart(opened, name, facts)}
          onEdit={(next) => setEdits((all) => ({ ...all, [opened]: next }))}
          onResetEdit={() => setEdits((all) => {
            const copy = { ...all }
            delete copy[opened]
            return copy
          })}
          onRemove={() => drop(opened)}
          onRestore={() => restore(opened)}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  )
}
