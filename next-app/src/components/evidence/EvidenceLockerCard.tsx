import type { EvidenceViewModel } from "./evidence.types"

type Props = {
  item: EvidenceViewModel
  onClick: () => void
}

export function EvidenceLockerCard({ item, onClick }: Props) {
  const title = item.label || item.fileName || "Evidence"

  return (
    <button
      type="button"
      onClick={onClick}
      className="group overflow-hidden rounded-xl border border-neutral-200 bg-white text-left shadow-sm transition hover:shadow-md"
    >
      <div className="aspect-square bg-neutral-100" id={`evidence-card-${String((item as any)?.id || (ev as any)?.id || "")}`} data-evidence-id={String((item as any)?.id || (ev as any)?.id || "")}>
        {item.thumbnailUrl || item.viewerUrl ? (
          <img
            src={item.thumbnailUrl ?? item.viewerUrl ?? ""}
            alt={title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            No preview
          </div>
        )}
      </div>

      <div className="space-y-1 p-3">
        <div className="truncate text-sm font-medium text-neutral-900">
          {title}
        </div>

        <div className="truncate text-xs text-neutral-600">
          {item.jobId ? `Job: ${item.jobId}` : "Unassigned"}
        </div>

        <div className="text-xs text-neutral-500">
          {formatDate(item.uploadedAt ?? item.createdAt)}
        </div>
      </div>
    </button>
  )
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown time"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "Unknown time"
  return d.toLocaleString()
}
