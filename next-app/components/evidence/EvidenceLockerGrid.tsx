import type { EvidenceViewModel } from "./evidence.types"
import { EvidenceLockerCard } from "./EvidenceLockerCard"

type Props = {
  items: EvidenceViewModel[]
  onSelect: (evidenceId: string) => void
}

export function EvidenceLockerGrid({ items, onSelect }: Props) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-8 text-sm text-neutral-500">
        No evidence uploaded yet.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {items.map((item) => (
        <EvidenceLockerCard
          key={item.id}
          item={item}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </div>
  )
}
