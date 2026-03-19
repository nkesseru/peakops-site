"use client";

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { runHealthChecks, type HealthCheck, type HealthReport } from "@/lib/health/runHealthChecks";

function badgeStyle(severity: HealthCheck["severity"]): CSSProperties {
  if (severity === "green") {
    return { background: "rgba(16,185,129,0.18)", color: "#a7f3d0", border: "1px solid rgba(52,211,153,0.35)" };
  }
  if (severity === "yellow") {
    return { background: "rgba(245,158,11,0.18)", color: "#fde68a", border: "1px solid rgba(251,191,36,0.35)" };
  }
  return { background: "rgba(239,68,68,0.18)", color: "#fecaca", border: "1px solid rgba(248,113,113,0.35)" };
}

function dotStyle(severity: HealthCheck["severity"]): CSSProperties {
  if (severity === "green") return { background: "#34d399" };
  if (severity === "yellow") return { background: "#fbbf24" };
  return { background: "#f87171" };
}

export default function AdminHealthPage() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  async function run() {
    setLoading(true);
    setError("");
    try {
      const out = await runHealthChecks();
      setReport(out);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run();
  }, []);

  const checksBySection = useMemo(() => {
    const src = report?.checks || [];
    const sections = ["Environment", "Functions", "Storage/Uploads", "HEIC Stack", "Demo Data"] as const;
    return sections.map((section) => ({
      section,
      items: src.filter((c) => c.section === section),
    }));
  }, [report]);

  const overall = useMemo(() => {
    if (!report) return "YELLOW";
    if (report.summary.fail > 0) return "RED";
    if (report.summary.warn > 0) return "YELLOW";
    return "GREEN";
  }, [report]);

  async function copyReport() {
    if (!report) return;
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 20 }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>PeakOps Health Dashboard</h1>
            <div style={{ marginTop: 6, opacity: 0.75, fontSize: 13 }}>
              Next + Functions + Firestore + Storage + HEIC stack checks
            </div>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={loading}
            style={{
              border: "1px solid rgba(255,255,255,0.2)",
              background: loading ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.12)",
              color: "#fff",
              borderRadius: 8,
              padding: "8px 12px",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Running..." : "Run Checks"}
          </button>
        </div>

        {error ? (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(127,29,29,0.5)" }}>
            {error}
          </div>
        ) : null}

        {report ? (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              Ran at: {report.ranAt}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
              functionsBase: <code>{report.config.functionsBase || "<empty>"}</code>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
              NODE_ENV: <code>{report.config.nodeEnv || "<empty>"}</code>
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 10, fontSize: 12, flexWrap: "wrap" }}>
              <span style={{ ...badgeStyle(overall === "GREEN" ? "green" : overall === "YELLOW" ? "yellow" : "red"), borderRadius: 999, padding: "2px 8px", fontWeight: 600 }}>
                Overall {overall}
              </span>
              <span style={{ ...badgeStyle("green"), borderRadius: 999, padding: "2px 8px" }}>OK {report.summary.ok}</span>
              <span style={{ ...badgeStyle("yellow"), borderRadius: 999, padding: "2px 8px" }}>Warn {report.summary.warn}</span>
              <span style={{ ...badgeStyle("red"), borderRadius: 999, padding: "2px 8px" }}>Fail {report.summary.fail}</span>
              <button
                type="button"
                onClick={copyReport}
                style={{
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.09)",
                  color: "#fff",
                  borderRadius: 999,
                  padding: "2px 10px",
                  cursor: "pointer",
                }}
              >
                {copied ? "Copied" : "Copy report"}
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          {checksBySection.map((group) => (
            <section
              key={group.section}
              style={{
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 10,
                background: "rgba(255,255,255,0.04)",
                padding: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15 }}>{group.section}</h2>
              {group.items.length === 0 ? (
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.6 }}>No checks</div>
              ) : (
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {group.items.map((c) => (
                    <div
                      key={`${group.section}-${c.name}`}
                      style={{
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 8,
                        padding: 10,
                        background: "rgba(0,0,0,0.25)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={{ ...dotStyle(c.severity), width: 8, height: 8, borderRadius: 999 }} />
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                        </div>
                        <div style={{ ...badgeStyle(c.severity), borderRadius: 999, padding: "2px 8px", fontSize: 11 }}>
                          {c.severity.toUpperCase()}
                        </div>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11, opacity: 0.75 }}>
                        result: {c.ok ? "PASS" : "FAIL"}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {c.details}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11, opacity: 0.55 }}>
                        latency: {c.latencyMs}ms
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
