# Prompt: the ask-the-model agent

Hand this to a fresh session in this repo.

---

Build the second half of the animation feature: a panel where someone types a
question about the model — "how do I increase the height of the chair?" — and
gets back a written answer *plus* one clip to press play on, assembled from the
generated animations.

## What already exists — read these first, do not rebuild them

- **`frontend/src/animGen.ts`** — the rule engine. `generate(input, wanted, pivot)`
  returns `{ clips, parts }`. Every clip it makes carries a `ClipMeta`.
- **`frontend/src/api.ts`** — `ClipMeta` is `{ kind, targets, labels, axis, amount,
  summary, tags }`, optional on `Clip` as `meta`. `kind` is one of `spin | hinge |
  unscrew | slide | raise | detach | highlight | turntable | explode | merged`.
  `summary` is a sentence; `tags` are the words a question would use
  (`height`, `remove`, `adjust`, …). **This is the retrieval surface. It exists
  for exactly this task.**
- **`frontend/src/animation.ts`** — `mergeClips(clips, name, 'sequence' | 'together')`
  already assembles several clips into one playable clip and writes a `merged`
  meta. `'sequence'` for steps, `'together'` for simultaneous motion. Read its
  doc comment: at a contested instant the *earlier* clip wins, deliberately.
- **`frontend/src/views/AnalysisView.tsx`** — holds `clips`, `renames`, `details`
  in state, and `player` / `Timeline` / `AnimGenerator`. The answer's clip is
  added to `clips` and selected like any other.
- **`backend/app/naming.py`** — `ask(system, blocks, schema, max_tokens, settings,
  effort=None) -> str | None` is the provider-agnostic call. It fans out to
  azure / openai / anthropic / compatible. `blocks` is a *function* taking an
  image builder; for a text-only question just ignore the argument and return
  your text blocks. **Do not add provider plumbing.**
- **`backend/app/main.py`** — `_configured()` returns the settings or raises the
  400 that says what is missing. `/api/agent/*` shows the route style.
- **`backend/app/parts_doc.py`** — the saved bundle's `parts.json` carries an
  `animations` list mirroring `ClipMeta`, plus `parts` with their `details`.
  Relevant only for a consumer reading an exported bundle; the in-app panel
  should use the live browser state instead, so it works before a save.

## Design — take the lazy one

**Stateless, one round trip.** This is not the naming agent: there are no images
to render, no looking again, no human in the loop. `agent.py`'s session/ReAct
machinery exists because vision is expensive and ambiguous. A question against a
text manifest is neither. Do **not** copy `Session`, `_sweep`, TTLs or a
`/step` endpoint.

Add **one** endpoint:

```
POST /api/ask
  { question: str,
    subject: str,                      # "office chair", if the namer settled one
    parts:      [{ name, details }],   # from renames + details
    animations: [{ name, duration, ...ClipMeta }] }
->
  { answer: str,                       # 2-4 sentences, plain prose
    picked: [int],                     # indices into `animations`, in play order
    mode:  "sequence" | "together",
    note:  str }                       # "" or why nothing fitted
```

The model returns **indices into the array it was sent**, not names — names are
free text and a hand-keyed clip can collide with a generated one.

### Prefilter before you spend a request

A 40-part model has 150+ animations. Score each one deterministically against
the question first — count `tags` and `summary` word overlap, weight `labels`
matches higher — and send only the top ~30 plus every whole-model clip. Cheap,
and it keeps the request small. Put the scorer in `animGen.ts` next to the meta
it reads (`rank(question, clips)`), not on the backend: it is pure string work
over data the browser already holds, and having it there means the panel can
show "nothing matched" without a request at all.

### Then

Browser: `mergeClips(picked.map(i => sent[i]), question, mode)` → push onto
`clips`, select it, `player.play()`. Show `answer` above it and the steps as a
list, each row naming the clip it came from.

## Constraints

- No new dependencies. No new settings fields unless the panel genuinely needs
  one — reuse `settings.provider` and the existing key storage.
- Text only. Do not render or send images; the manifest is the evidence.
- If nothing scores above a floor, say so and spend no request.
- A question is untrusted input. It goes in a user message, never into the
  system prompt, and the reply's `picked` indices must be bounds-checked before
  they index anything.
- Match the house style: British spelling, comments that say *why*, and doc
  comments on anything non-obvious. Read a neighbouring module first.

## Verify

- One `test_ask.py` with the provider stubbed: a reply picking indices merges the
  right clips in the right order; an out-of-range index is rejected rather than
  crashing; an empty `animations` list answers without a request.
- A `rank()` check: "how do I make the chair taller" puts the `raise` clip on the
  gas lift above the `highlight` on a castor.
- `cd frontend && npx tsc -b --force` and `cd backend && python -m pytest -q`
  both clean. `npm run build` must still emit `ModelViewer` as its own chunk —
  importing a *value* from `ModelViewer.tsx` collapses the lazy chunk into the
  main bundle. Shared values go in `partGraph.ts`.

## Known ceiling, do not fix unless asked

`hinge` turns a part about its own origin, so a door whose origin is at its
centre reads as a tilt. Giving parts a real pivot means changing `Pose`, which
is out of scope here.
