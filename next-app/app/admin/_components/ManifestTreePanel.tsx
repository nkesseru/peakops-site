"use client";

import React, { useState } from "react";
import JSZip from "jszip";

type Item = { path: string; bytes?: number | null; sha256?: string | null };

export default function ManifestTreePanel(props: {
  packetZipUrl: string;
  disabled?: boolean;
}) {
  const { packetZipUrl, disabled } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [items, setItems] = useState<Item[]>([]);

  async function load() {
    if (busy || disabled) return;
    setBusy(true);
    setErr("");
    setItems([]);
    try {
      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`packet zip download failed (HTTP ${r.status})`);
      const buf = await r.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);

      const manFile = zip.file("manifest.json");
      const hashFile = zip.file("hashes.json");
      if (!manFile) throw new Error("manifest.json not found in ZIP");
      if (!hashFile) throw new Error("hashes.json not found in ZIP");

      const manText = await manFile.async("string");
      const hashText = await hashFile.async("string");

      const man = JSON.parse(manText || "{}");
      const hashes = JSON.parse(hashText || "{}");

      let files: any[] = [];
      if (Array.isArray(man.files)) files = man.files;
      else if (Array.isArray(man.items)) files = man.items;
      else if (Array.isArray(man.manifest)) files = man.manifest;

      const out: Item[] = [];
      for (const f of files) {
        const path = String(f?.path || f?.name || "").trim();
        if (!path) continue;
        const bytes =
          typeof f?.bytes === "number" ? f.bytes :
          (typeof f?.size === "number" ? f.size : null);
        const sha =
          (f?.sha256 || f?.hash) ? String(f.sha256 || f.hash) : null;
        out.push({ path, bytes, sha256: sha });
      }

      if (hashes && typeof hashes === "object" && !Array.isArray(hashes)) {
        for (const it of out) {
          if (!it.sha256) {
            const v = (hashes as any)[it.path] || (hashes as any)[it.path.replace(/^\.\//, "")];
            if (typeof v === "string" && v) it.sha256 = v;
          }
        }
      }

      out.sort((a, b) => a.path.localeCompare(b.path));
      setItems(out);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", borderRadius: 16, padding: 16 }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>Files</div>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
        Load manifest.json + hashes.json from the Packet ZIP and render a normalized file list.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={load}
          disabled={busy || !!disabled}
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.06)",
            color: "white",
            padding: "8px 12px",
            borderRadius: 12,
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {busy ? "Loading…" : "Load File Tree"}
        </button>

        {err && <span style={{ color: "#ff6b6b", fontWeight: 900, fontSize: 12 }}>{err}</span>}
        {!err && items.length > 0 && <span style={{ fontSize: 12, opacity: 0.85 }}>{items.length} files</span>}
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>Path</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>Bytes</th>
                <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>sha256</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.path}>
                  <td style={{ padding: "6px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {it.path}
                  </td>
                  <td style={{ padding: "6px", borderBottom: "1px solid rgba(255,255,255,0.06)", textAlign: "right", opacity: 0.9 }}>
                    {typeof it.bytes === "number" ? it.bytes : "—"}
                  </td>
                  <td style={{ padding: "6px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.9 }}>
                    {it.sha256 || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
