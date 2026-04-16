"use client";

import { useMemo } from "react";

type Props = {
  /** Either provide `value` (object) OR `text` (string). */
  value?: any;
  text?: string;
  collapsed?: number | boolean;
  /** If true, render in a compact single-line-ish mode (still readable). */
  dense?: boolean;
};

function safeParse(text?: string) {
  if (!text) return { ok: false, value: null as any };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null as any };
  }
}

export default function PrettyJson({ value, text, dense = false }: Props) {
  const parsed = useMemo(() => safeParse(text), [text]);
  const data = value !== undefined ? value : (parsed.ok ? parsed.value : null);

  // If we got text but couldn't parse, show raw text in a nice pre.
  if (value === undefined && text !== undefined && !parsed.ok) {
    return (
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
          lineHeight: 1.5,
          opacity: 0.95,
          fontFamily: "ui-monospace, Menlo, monospace",
          margin: 0,
        }}
      >
        {text}
      </pre>
    );
  }

  const pretty = (() => {
    try {
      return JSON.stringify(data ?? {}, null, dense ? 0 : 2);
    } catch {
      return String(data ?? "");
    }
  })();

  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: dense ? 12 : 13,
        lineHeight: 1.55,
        fontFamily: "ui-monospace, Menlo, monospace",
        margin: 0,
        backgroundColor: "transparent",
        padding: 0,
      }}
    >
      {pretty}
    </pre>
  );
}
