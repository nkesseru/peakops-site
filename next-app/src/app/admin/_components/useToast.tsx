"use client";
import { useCallback, useState } from "react";

export function useToast() {
  const [msg, setMsg] = useState<string>("");
  const [kind, setKind] = useState<"ok"|"err"|"">("");

  const show = useCallback((k:"ok"|"err", m:string) => {
    setKind(k); setMsg(m);
    window.setTimeout(() => { setKind(""); setMsg(""); }, 1800);
  }, []);

  const Toast = kind ? (
    <div style={{
      position:"fixed",
      right: 18,
      top: 18,
      zIndex: 9999,
      padding: "10px 12px",
      borderRadius: 14,
      background: kind === "ok" ? "color-mix(in oklab, lime 18%, black)" : "color-mix(in oklab, red 18%, black)",
      border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
      color: "CanvasText",
      fontWeight: 900,
      backdropFilter: "blur(10px)"
    }}>
      {msg}
    </div>
  ) : null;

  return { show, Toast };
}
