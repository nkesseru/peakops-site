"use client";

import { useMemo, useState } from "react";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// cheap-ish JSON highlighter: keys, strings, numbers, booleans, null
function highlightJson(json: string) {
  const esc = escapeHtml(json);

  // keys: "foo":
  let out = esc.replace(/"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:/g, (m) => {
    return `<span style="color:#8ab4f8;font-weight:800">${m}</span>`;
  });

  // strings (not keys): "bar"
  out = out.replace(/:\s*("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")/g, (_m, g1) => {
    return `: <span style="color:#9ae6b4">${g1}</span>`;
  });

  // numbers
  out = out.replace(/:\s*(-?\d+(\.\d+)?([eE][+\-]?\d+)?)/g, (_m, g1) => {
    return `: <span style="color:#fbbf24">${g1}</span>`;
  });

  // booleans + null
  out = out.replace(/:\s*(true|false|null)/g, (_m, g1) => {
    const c = g1 === "null" ? "#a3a3a3" : "#f472b6";
    return `: <span style="color:${c};font-weight:800">${g1}</span>`;
  });

  return out;
}

export default function JsonCodeBlock(props: { value: any; title?: string; defaultWrap?: boolean }) {
  const [wrap, setWrap] = useState(!!props.defaultWrap);

  const json = useMemo(() => {
    try {
      if (typeof props.value === "string") return props.value;
      return JSON.stringify(props.value ?? {}, null, 2);
    } catch {
      return String(props.value ?? "");
    }
  }, [props.value]);

  const html = useMemo(() => highlightJson(json), [json]);

  const lines = useMemo(() => {
    const n = json.split("\n").length;
    return Array.from({ length: n }, (_, i) => String(i + 1));
  }, [json]);

  async function copy() {
    try { await navigator.clipboard.writeText(json); } catch {}
  }

  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 16,
        overflow: "hidden",
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px",
          borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.85 }}>
          {props.title || "JSON"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setWrap((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "transparent",
              color: "CanvasText",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              opacity: 0.9,
            }}
          >
            {wrap ? "No wrap" : "Wrap"}
          </button>
          <button
            onClick={copy}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "transparent",
              color: "CanvasText",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              opacity: 0.9,
            }}
          >
            Copy
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "52px 1fr" }}>
        <pre
          style={{
            margin: 0,
            padding: "12px 10px",
            background: "transparent",
            borderRight: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            color: "color-mix(in oklab, CanvasText 55%, transparent)",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            textAlign: "right",
            userSelect: "none",
            overflow: "hidden",
          }}
        >
          {lines.join("\n")}
        </pre>

        <pre
          style={{
            margin: 0,
            padding: 12,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            wordBreak: wrap ? "break-word" : "normal",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            overflow: "auto",
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
