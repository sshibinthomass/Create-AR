import type { PartEdit } from '../api'
import { usePartShot } from '../usePartShot'

/**
 * The selected part on its own, beside the assembly it came out of.
 *
 * A thumbnail rather than a view: it says what the part looks like at a glance,
 * and clicking it opens the same render full size, where the part can be named,
 * described and edited on its own. The rendering itself lives in `usePartShot`,
 * which the full-size dialog uses too.
 */
export default function PartPreview({ url, index, name, edit, onOpen }: {
  url: string
  /** Which part, by its position in the viewer's list. */
  index: number
  name: string
  /** The move, rotation, scale and material the viewer is showing it with. */
  edit?: PartEdit
  /** Open this part on its own, full size. */
  onOpen: () => void
}) {
  const { data, failed, touched } = usePartShot(url, index, edit)

  return (
    <aside className="part-shot">
      <button
        type="button"
        className="part-shot-frame"
        title={`Open ${name || 'this part'} on its own`}
        onClick={onOpen}
      >
        {data ? (
          <img src={`data:image/jpeg;base64,${data}`} alt={`${name}, on its own`} />
        ) : (
          <span className="part-shot-wait">{failed ? 'No preview' : 'Rendering…'}</span>
        )}
        <span className="part-shot-open">Open</span>
      </button>
      <div className="part-shot-cap">{touched ? 'This part, edited' : 'This part alone'}</div>
    </aside>
  )
}
