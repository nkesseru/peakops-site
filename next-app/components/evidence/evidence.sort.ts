import type { EvidenceViewModel } from "./evidence.types"

export function sortEvidenceForViewer(
  items: EvidenceViewModel[]
): EvidenceViewModel[] {
  return [...items].sort((a, b) => {
    const aKey = getSortKey(a)
    const bKey = getSortKey(b)

    if (aKey > bKey) return -1
    if (aKey < bKey) return 1

    return b.id.localeCompare(a.id)
  })
}

function getSortKey(item: EvidenceViewModel): string {
  return item.uploadedAt ?? item.createdAt ?? item.id
}
