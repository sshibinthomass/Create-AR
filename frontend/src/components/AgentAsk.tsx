import { useEffect, useRef, useState } from 'react'
import type { PendingAsk } from '../useAgent'

/**
 * The point where the run stops and asks.
 *
 * There is one question worth a person's time above all others: what the model
 * is. Everything downstream hangs off that sentence, and getting it wrong is
 * what turns an office chair into an all-terrain vehicle -- so it is put on
 * screen with the picture the agent formed it from, before forty-odd parts are
 * named against it. The part questions that follow it are the ones the agent
 * itself flagged as shaky, and only those: a panel that asks about everything
 * teaches you to click through it without reading.
 *
 * Answering with the suggestion accepts it. Typing something else replaces it,
 * and the agent works from what you typed from then on.
 */
export default function AgentAsk({
  pending, onAnswer, onStop,
}: {
  pending: PendingAsk
  /** Empty means "yes, as proposed"; anything else replaces it. */
  onAnswer: (answer: string) => void
  onStop: () => void
}) {
  const { ask, image } = pending
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLInputElement>(null)

  // A new question clears whatever was typed for the last one.
  useEffect(() => {
    setDraft('')
  }, [ask.question, ask.index])

  const correct = () => {
    const said = draft.trim()
    if (said) onAnswer(said)
    else field.current?.focus()
  }

  return (
    <div className="agent-ask">
      {image && (
        <img
          className="agent-shot"
          src={`data:image/jpeg;base64,${image}`}
          alt={ask.kind === 'subject'
            ? 'The whole model, as the agent saw it'
            : 'The part in question, highlighted in its surroundings'}
        />
      )}
      <div className="agent-ask-body">
        <p className="agent-q">{ask.question}</p>
        {ask.detail && <p className="agent-why">{ask.detail}</p>}

        <div className="agent-actions">
          <button className="go" onClick={() => onAnswer('')}>
            {ask.kind === 'subject' ? 'Yes, that is it' : 'Yes, keep it'}
          </button>
          <button className="head-reset" onClick={onStop}>Stop the run</button>
        </div>

        <label className="agent-fix">
          <span>{ask.kind === 'subject' ? 'No — it is a…' : 'No — call it…'}</span>
          <input
            ref={field}
            value={draft}
            placeholder={ask.options[0] ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') correct()
            }}
          />
          <button className="head-reset" disabled={!draft.trim()} onClick={correct}>
            Use this
          </button>
        </label>
      </div>
    </div>
  )
}
