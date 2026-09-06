import type { RunReport } from '../useAgent'

/**
 * What the run decided, once it has finished.
 *
 * A namer that just fills the list leaves you no way to tell a confident answer
 * from a guess, which is how forty-six wrong names got saved without anyone
 * noticing. So the run says out loud what it took the model to be -- the one
 * assumption every name rests on -- and lists the parts it was not sure of,
 * with the reason it gave. Those are the rows worth opening before saving.
 */
export default function AgentReport({
  report, onOpenPart, onDismiss,
}: {
  report: RunReport
  /** Jump to one part in the list, by its position. */
  onOpenPart: (index: number) => void
  onDismiss: () => void
}) {
  return (
    <div className="agent-report">
      <div className="agent-report-head">
        <span className="agent-badge">Named</span>
        <button className="head-reset" onClick={onDismiss}>Dismiss</button>
      </div>

      {report.subject && (
        <p className="agent-subject">
          Read as <strong>{report.subject}</strong>. Every name was given on that
          basis — if it is wrong, the names are too.
        </p>
      )}
      {report.summary && <p className="agent-why">{report.summary}</p>}

      {report.unsure.length > 0 ? (
        <>
          <p className="agent-why">
            {report.unsure.length === 1
              ? 'One part it was not sure of:'
              : `${report.unsure.length} parts it was not sure of:`}
          </p>
          <ul className="agent-unsure">
            {report.unsure.map((part) => (
              <li key={part.index}>
                <button className="link" onClick={() => onOpenPart(part.index)}>
                  {part.name}
                </button>
                {part.evidence && <span> — {part.evidence}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="agent-why">It was confident about every part.</p>
      )}
    </div>
  )
}
