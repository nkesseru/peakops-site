import type { EvidenceViewModel } from "./evidence.types"

type EvidenceRecord = Record<string, any>

export function mapEvidenceToViewModel(
  record: EvidenceRecord
): EvidenceViewModel {
  return {
    id: String(record.id ?? ""),
    incidentId: record.incidentId ?? null,
    jobId: record.jobId ?? null,
    label: record.label ?? null,
    fileName: record.fileName ?? null,
    mimeType: record.mimeType ?? null,
    uploadedAt: normalizeDate(record.uploadedAt),
    createdAt: normalizeDate(record.createdAt),
    thumbnailUrl: record.thumbnailUrl ?? null,
    viewerUrl:
      record.viewerUrl ??
      record.readUrl ??
      record.signedReadUrl ??
      record.thumbnailUrl ??
      null,
    raw: record,
  }
}

function normalizeDate(value: unknown): string | null {
  if (!value) return null

  if (typeof value === "string") return value

  if (typeof value === "number") {
    try {
      return new Date(value).toISOString()
    } catch {
      return null
    }
  }

  if (typeof value === "object" && value !== null) {
    const maybeSeconds =
      (value as any).seconds ??
      (value as any)._seconds

    if (typeof maybeSeconds === "number") {
      try {
        return new Date(maybeSeconds * 1000).toISOString()
      } catch {
        return null
      }
    }
  }

  return null
}
