import type { EvidenceViewModel } from "./evidence.types"

type Props = {
  item: EvidenceViewModel
}

export function EvidenceMetadataPanel({ item }: Props) {
  return (
    <div className="space-y-4">
      <Section label="Label" value={item.label || "Unlabeled"} />
      <Section label="File" value={item.fileName || "Unknown file"} />
      <Section label="Job" value={item.jobId || "Unassigned"} />
      <Section
        label="Uploaded"
        value={formatDate(item.uploadedAt ?? item.createdAt)}
      />
      <Section label="Type" value={item.mimeType || "Unknown"} />
      <Section label="Evidence ID" value={item.id} mono />
    </div>
  )
}

function Section({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={
          mono
            ? "break-all font-mono text-sm text-neutral-900"
            : "text-sm text-neutral-900"
        }
      >
        {value}
      </div>
    </div>
  )
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown time"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "Unknown time"
  return d.toLocaleString()
}
