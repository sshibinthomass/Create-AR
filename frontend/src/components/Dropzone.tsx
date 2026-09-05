import { useRef, useState } from 'react'
import { formatBytes } from '../api'

interface Props {
  file: File | null
  accept: string[]
  maxBytes: number
  onSelect: (file: File | null) => void
  onReject: (message: string) => void
}

export default function Dropzone({ file, accept, maxBytes, onSelect, onReject }: Props) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  function validate(candidate: File) {
    const dot = candidate.name.lastIndexOf('.')
    const ext = dot >= 0 ? candidate.name.slice(dot).toLowerCase() : ''
    if (!accept.includes(ext)) {
      onReject(
        `"${ext || candidate.name}" is not a supported input format. Accepted: ${accept.join(', ')}`,
      )
      return
    }
    if (candidate.size > maxBytes) {
      onReject(`That file is ${formatBytes(candidate.size)}; the limit is ${formatBytes(maxBytes)}.`)
      return
    }
    if (candidate.size === 0) {
      onReject('That file is empty.')
      return
    }
    onSelect(candidate)
  }

  if (file) {
    const dot = file.name.lastIndexOf('.')
    const ext = dot >= 0 ? file.name.slice(dot + 1).toUpperCase() : '?'
    return (
      <div className="file-chip">
        <span className="ext">{ext}</span>
        <div className="meta">
          <div className="name" title={file.name}>{file.name}</div>
          <div className="sub">{formatBytes(file.size)}</div>
        </div>
        <button className="x" onClick={() => onSelect(null)} aria-label="Remove file">&times;</button>
      </div>
    )
  }

  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const dropped = e.dataTransfer.files?.[0]
        if (dropped) validate(dropped)
      }}
    >
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--dim)' }}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <p>Drop a 3D model here</p>
      <p className="hint">{accept.join('  ')}</p>
      <button onClick={() => input.current?.click()}>Browse files</button>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept.join(',')}
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) validate(picked)
          e.target.value = ''
        }}
      />
    </div>
  )
}
