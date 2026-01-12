"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

const JsonView = dynamic(() => import("@uiw/react-json-view").then((m: any) => m.default ?? m), { ssr: false });

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

export default function PrettyJson({ value, text, collapsed = 1, dense = false }: Props) {
  const parsed = useMemo(() => safeParse(text), [text]);
  const data = value !== undefined ? value : (parsed.ok ? parsed.value : null);

  // If we got text but couldn't parse, show raw text in a nice pre.
  if (value === undefined && text !== undefined && !parsed.ok) {
    return (
      <pre style={{
        whiteSpace: "pre-wrap",
        fontSize: 12,
        lineHeight: 1.5,
        opacity: 0.95,
        fontFamily: "ui-monospace, Menlo, monospace",
        margin: 0,
      }}>
{text}
      </pre>
    );
  }

  return (
    <div style={{ margin: 0 }}>
      <JsonView
        value={data ?? {}}
        collapsed={collapsed}
        displayDataTypes={false}
        displayObjectSize={false}
        enableClipboard={false}
        shortenTextAfterLength={dense ? 40 : 120}
        style={{
          backgroundColor: "transparent",
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: dense ? 12 : 13,
          lineHeight: 1.55,
          padding: 0,
        }}
      />
    </div>
  );
}
