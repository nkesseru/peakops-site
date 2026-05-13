"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function pill(active: boolean) {
  return {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 4%, transparent)",
    color: "CanvasText",
    fontWeight: 800,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  } as const;
}

export default function AdminNav(props: {
  contractId?: string;
  versionId?: string;
  showJump?: boolean;
}) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const orgId = sp.get("orgId") || "org_001";
  const contractId = props.contractId || sp.get("contractId") || "";
  const versionId = props.versionId || sp.get("versionId") || "v1";

  const base = useMemo(() => {
    const q = `orgId=${encodeURIComponent(orgId)}`;
    return {
      contracts: `/admin/contracts?${q}`,
      contract: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}?${q}` : "",
      payloads: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads?${q}` : "",
      packet: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/packet?${q}&versionId=${encodeURIComponent(versionId)}` : "",
    };
  }, [orgId, contractId, versionId]);

  // Normalize orgId in URL (prevents orgId=undefined calls)
  useEffect(() => {
    if (!sp.get("orgId")) {
      const u = new URL(window.location.href);
      u.searchParams.set("orgId", orgId);
      router.replace(u.pathname + "?" + u.searchParams.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const items = useMemo(() => {
    const out: { label: string; href: string; meta?: string }[] = [];
    out.push({ label: "Contracts", href: base.contracts, meta: "List" });
    if (base.contract) out.push({ label: "Contract Overview", href: base.contract, meta: contractId || "" });
    if (base.payloads) out.push({ label: "Payloads", href: base.payloads, meta: "Schemas" });
    if (base.packet) out.push({ label: "Packet Preview", href: base.packet, meta: "Tree + JSON" });
    return out;
  }, [base, contractId]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter(x => (x.label + " " + (x.meta || "")).toLowerCase().includes(t));
  }, [items, q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen(v => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
        <a href={base.contracts} style={pill(pathname === "/admin/contracts")}>Contracts</a>
        {base.contract && <a href={base.contract} style={pill(pathname.includes("/admin/contracts/") && !pathname.includes("/payloads") && !pathname.includes("/packet"))}>Contract Overview</a>}
        {base.payloads && <a href={base.payloads} style={pill(pathname.includes("/payloads") && !pathname.includes("/payloads/"))}>Payloads</a>}
        {base.packet && <a href={base.packet} style={pill(pathname.includes("/packet"))}>Packet Preview</a>}

        {(props.showJump ?? true) && (
          <button
            onClick={() => setOpen(true)}
            style={{
              marginLeft: 6,
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
              background: "color-mix(in oklab, CanvasText 4%, transparent)",
              color: "CanvasText",
              fontWeight: 900,
              cursor: "pointer",
              display:"inline-flex",
              gap:8,
              alignItems:"center"
            }}
            title="⌘K"
          >
            <span style={{ opacity: 0.9 }}>⌘K</span>
            <span style={{ opacity: 0.8 }}>Jump</span>
          </button>
        )}
      </div>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 9999,
            display: "grid",
            placeItems: "start center",
            paddingTop: 120,
          }}
        >
          <div
            onClick={(e)=>e.stopPropagation()}
            style={{
              width: "min(760px, 92vw)",
              borderRadius: 16,
              border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
              background: "color-mix(in oklab, Canvas 92%, black)",
              padding: 14,
            }}
          >
            <input
              autoFocus
              value={q}
              onChange={(e)=>setQ(e.target.value)}
              placeholder="Type to jump… (Contracts, Payloads, Packet)"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 12,
                border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                background: "Canvas",
                color: "CanvasText",
                fontSize: 14,
                fontWeight: 700,
              }}
            />
            <div style={{ marginTop: 10, display:"grid", gap:8 }}>
              {filtered.map((x) => (
                <a
                  key={x.href}
                  href={x.href}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
                    background: "color-mix(in oklab, CanvasText 3%, transparent)",
                    color: "CanvasText",
                    textDecoration:"none",
                    display:"flex",
                    justifyContent:"space-between",
                    gap:12,
                    fontWeight: 850
                  }}
                  onClick={()=>setOpen(false)}
                >
                  <span>{x.label}</span>
                  <span style={{ opacity: 0.6, fontWeight: 700 }}>{x.meta || ""}</span>
                </a>
              ))}
              {filtered.length === 0 && <div style={{ opacity: 0.7, padding: 10 }}>No matches.</div>}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              Enter to open · Esc to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
