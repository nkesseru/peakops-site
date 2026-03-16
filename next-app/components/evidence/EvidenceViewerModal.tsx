"use client"

import { useEffect, useMemo, useState } from "react"
import type { EvidenceViewModel } from "./evidence.types"
import { EvidenceMetadataPanel } from "./EvidenceMetadataPanel"

type Props = {
  items: EvidenceViewModel[]
  selectedEvidenceId: string | null
  onClose: () => void
  onSelect: (evidenceId: string) => void
}

export function EvidenceViewerModal({
  items,
  selectedEvidenceId,
  onClose,
  onSelect,
}: Props) {
  const selectedIndex = useMemo(
    () => items.findIndex((item) => item.id === selectedEvidenceId),
    [items, selectedEvidenceId]
  )

  const item = selectedIndex >= 0 ? items[selectedIndex] : null
  const isOpen = !!item

  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    setLoadFailed(false)
  }, [item?.id, item?.viewerUrl])

  function goPrev() {
    if (selectedIndex <= 0) return
    onSelect(items[selectedIndex - 1].id)
  }

  function goNext() {
    if (selectedIndex >= items.length - 1) return
    onSelect(items[selectedIndex + 1].id)
  }

  useEffect(() => {
    if (!isOpen) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
      if (e.key === "ArrowLeft") goPrev()
      if (e.key === "ArrowRight") goNext()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isOpen, selectedIndex, items, onClose])

  if (!isOpen || !item) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="relative flex h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white lg:flex-row">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-md bg-black/60 px-3 py-1 text-sm text-white"
        >
          Close
        </button>

        <div className="relative flex min-h-[320px] flex-1 items-center justify-center bg-neutral-950 p-6">
          <button
            type="button"
            onClick={goPrev}
            disabled={selectedIndex <= 0}
            className="absolute left-4 rounded-md bg-white/10 px-3 py-2 text-white disabled:opacity-30"
          >
            ←
          </button>

          {!item.viewerUrl ? (
            <FallbackMessage message="No viewer URL available." />
          ) : loadFailed ? (
            <FallbackMessage message="Unable to load this evidence preview." />
          ) : (
            <img
              key={`${item.id}:${item.viewerUrl}`}
              src={item.viewerUrl}
              alt={item.label || item.fileName || "Evidence"}
              className="max-h-full max-w-full object-contain"
              onError={() => setLoadFailed(true)}
            />
          )}

          <button
            type="button"
            onClick={goNext}
            disabled={selectedIndex >= items.length - 1}
            className="absolute right-4 rounded-md bg-white/10 px-3 py-2 text-white disabled:opacity-30"
          >
            →
          </button>
        </div>

        <div className="w-full border-t border-neutral-200 p-5 lg:w-[360px] lg:border-l lg:border-t-0">
          <EvidenceMetadataPanel item={item} />
        </div>
      </div>
    </div>
  )
}

function FallbackMessage({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-200">
      {message}
    </div>
  )
}
