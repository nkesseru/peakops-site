require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const {
  assertActorRole,
  assertIncidentBelongsToOrg,
  httpStatusFromAuthzError,
  ROLES_GENERATE_REPORT,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const {
  requireEntitlement,
  httpStatusFromEntitlementError,
} = require("./_entitlement");
// PR 103a — Shared acceptance-readiness compute. Same helper used by
// getAcceptanceReadinessV1 and by the export pipeline below, so the
// readiness state embedded in the packet matches what the operator
// saw on the Summary page seconds earlier.
const { computeAcceptanceReadiness } = require("./_readiness");
const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Lazy-loaded so a require failure (e.g. partial deploy) can't take
// down the export entirely — notifications are best-effort.
let _notify = null;
try { _notify = require("./_notify"); } catch (_) { /* ignore */ }

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}
function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}
// PEAKOPS_EXPORT_EMU_GATE_V2 (2026-04-24)
// Canonical emulator flags only — drop the FIREBASE_STORAGE_EMULATOR_HOST
// disjunct that leaks into prod via the checked-in env.runtime.
function isEmu() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB;
}
function emuStorageHost() {
  return String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").trim();
}
function emuDownloadUrl(bucket, storagePath) {
  const host = emuStorageHost();
  return `http://${host}/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(storagePath)}?alt=media`;
}
async function writeJson(fp, obj) {
  await fs.promises.writeFile(fp, JSON.stringify(obj, null, 2), "utf8");
}
// PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
// stableSortKeys + stableStringify: produce byte-identical JSON for the
// same input object regardless of how its keys were originally inserted.
// Used for original-record/ files so re-exporting the same incident
// produces the same originalRecordHash. Mirrors the approach in
// evidenceExport.mjs.
function stableSortKeys(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stableSortKeys);
  if (typeof obj === "object") {
    // Skip Firestore Timestamp-like objects ({ _seconds, _nanoseconds })
    // so they serialize as a plain object with the same field order
    // every time. JSON.stringify handles plain objects deterministically
    // once their keys are sorted.
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = stableSortKeys(obj[k]);
    return out;
  }
  return obj;
}
function stableStringify(obj) {
  return JSON.stringify(stableSortKeys(obj), null, 2);
}
async function writeStableJson(fp, obj) {
  await fs.promises.writeFile(fp, stableStringify(obj), "utf8");
}
// PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
// Walk a directory recursively and yield { relPath, fullPath } for every
// file. Used by computeOriginalRecordHash to enumerate the original-
// record/ contents in deterministic order. Sorted ascending by relPath
// so the resulting hash map's key order is stable.
async function walkFiles(rootDir) {
  const out = [];
  async function recur(dir, prefix) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await recur(full, rel);
      } else if (e.isFile()) {
        out.push({ relPath: rel, fullPath: full });
      }
    }
  }
  await recur(rootDir, "");
  return out;
}
// PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
// Compute the originalRecordHash. The hash file itself is excluded from
// the input (it doesn't exist yet at compute time; this guard documents
// the recursion-avoidance contract — even if it did exist from a prior
// run, it would be excluded). The hash is sha256 of a stable-stringified
// { relPath: sha256(fileBytes) } map.
async function computeOriginalRecordHash(originalRecordDir, excludeRelPath) {
  const files = await walkFiles(originalRecordDir);
  const filtered = files.filter((f) => f.relPath !== excludeRelPath);
  const perFile = {};
  for (const f of filtered) {
    const buf = await fs.promises.readFile(f.fullPath);
    perFile[f.relPath] = require("crypto").createHash("sha256").update(buf).digest("hex");
  }
  const manifestStr = stableStringify(perFile);
  const hash = require("crypto").createHash("sha256").update(manifestStr, "utf8").digest("hex");
  return { hash: `sha256:${hash}`, perFile };
}
// PEAKOPS_EXPORT_FETCH_BYTES_V2 (2026-04-24)
// Previously this hard-coded a 127.0.0.1:9199 emulator URL, making every
// evidence download fail in production. Use the Admin SDK's file.download()
// which transparently talks to GCS in prod and the Storage emulator in dev
// (the admin library honors FIREBASE_STORAGE_EMULATOR_HOST when set).
async function fetchEvidenceBytes(bucket, storagePath) {
  const [buf] = await getStorage().bucket(bucket).file(storagePath).download();
  return buf;
}
// PEAKOPS_EXPORT_ZIP_V2 (2026-04-24)
// Replace `execFile("zip", …)` with node-native archiver. The GCF Node 20
// runtime has no `zip` binary; the old execFile call failed with ENOENT and
// returned 500 before any bytes hit Storage. `archiver` is already a
// functions_clean package.json dep and the same lib exportIncidentArtifactV1
// uses.
function runZip(cwd, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err?.code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(cwd, false);
    archive.finalize();
  });
}
function isApprovedJob(job) {
  const rs = String(job?.reviewStatus || "").trim().toLowerCase();
  const st = String(job?.status || "").trim().toLowerCase();
  return rs === "approved" || st === "approved";
}
function getEvidenceJobId(ev) {
  const top = String(ev?.jobId || "").trim();
  if (top) return top;
  const nested = String(ev?.evidence?.jobId || "").trim();
  return nested || null;
}
function normalizeTimelineType(type) {
  return String(type || "").trim().toLowerCase();
}

// PEAKOPS_EXPORT_AUDIT_READY_V1 (2026-04-30)
// Server-side mirror of the frontend prettyTimelineType so the
// timeline JSON in the customer ZIP reads in operator language
// (`"Submitted to supervisor"`) rather than raw event tokens
// (`"field_submitted"`).
function prettyTimelineType(type) {
  const key = normalizeTimelineType(type);
  const m = {
    notes_saved: "Notes saved",
    evidence_added: "Photos saved",
    field_arrived: "Field arrived",
    field_submitted: "Submitted to supervisor",
    field_approved: "Supervisor approved",
    material_added: "Material logged",
    incident_opened: "Incident opened",
    incident_closed: "Incident closed",
    session_started: "Field session started",
    job_created: "Task created",
    job_completed: "Task completed",
    task_completed: "Task completed",
    job_approved: "Task approved",
    task_approved: "Task approved",
    job_rejected: "Task sent back",
    task_rejected: "Task sent back",
    job_locked: "Task locked",
    supervisor_request_update: "Update requested",
  };
  if (m[key]) return m[key];
  if (!key) return "Event";
  return key
    .replace(/^job_/, "task_")
    .replace(/_/g, " ")
    .replace(/^./, (x) => x.toUpperCase());
}

// PEAKOPS_EXPORT_AUDIT_READY_V1 (2026-04-30)
// Customer-facing decision string for an approval entry. Reads
// reviewStatus first (the canonical field for review decisions),
// falls back to status. Returns plain English, never enum tokens.
function humanizeJobDecision(job) {
  const rs = String(job?.reviewStatus || "").trim().toLowerCase();
  const st = String(job?.status || "").trim().toLowerCase();
  const k = rs || st;
  if (k === "approved") return "Approved";
  if (k === "rejected" || k === "revision_requested") return "Sent back";
  if (k === "review") return "In review";
  if (k === "complete") return "Complete";
  if (k === "in_progress") return "In progress";
  if (k === "open") return "Open";
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : "Unknown";
}

function slugify(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || "untitled";
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// PR 98a — Deterministic label → slug. Mirrors the next-app helper
// (slugRequirement in AddEvidenceClient.tsx) byte-for-byte so the
// client-side slot key on each evidence doc matches the export-time
// slot key derived from the snapshot label. Backend regex
// ^[a-z0-9-]{1,120}$ stays satisfied.
function slugRequirement(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

// PEAKOPS_REPORT_LABELS_V1 (2026-05-01)
// Resolve Firebase UIDs → human display labels for any actor field
// (approvedBy / rejectedBy) the cover doc and bundled JSONs render.
// Priority: displayName → email → role label (Supervisor / Admin) →
// "Authorized reviewer". Never returns a UID. The UID itself stays
// only on Firestore (system-of-record) — REPORT_SUMMARY.html and the
// ZIP'd JSON files only ever carry the label.
function prettyActor(u) {
  const name = String(u?.displayName || "").trim();
  if (name) return name;
  const email = String(u?.email || "").trim();
  if (email) return email;
  const role = String((u?.customClaims || {}).role || "").toLowerCase();
  if (role === "supervisor") return "Supervisor";
  if (role === "admin") return "Admin";
  if (role === "field") return "Field crew";
  return "Authorized reviewer";
}

async function resolveActorLabels(uids) {
  const labels = new Map();
  const list = Array.from(uids).map((u) => String(u || "").trim()).filter(Boolean);
  if (list.length === 0) return labels;
  // admin.auth().getUsers takes up to 100 identifiers per call.
  // Chunk defensively even though >100 unique approvers per incident
  // is effectively impossible.
  const chunks = [];
  for (let i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const result = await admin.auth().getUsers(chunk.map((uid) => ({ uid })));
      for (const u of (result.users || [])) {
        labels.set(u.uid, prettyActor(u));
      }
      for (const nf of (result.notFound || [])) {
        // Auth lookup couldn't find this UID — treat as a deleted /
        // invalidated user. Fall back to the generic label, never
        // the UID.
        labels.set(nf.uid, "Authorized reviewer");
      }
    } catch (e) {
      // If the entire lookup fails (rare — bad creds, network), every
      // unresolved UID falls back to the generic label so the report
      // body never carries a raw UID.
      for (const uid of chunk) {
        if (!labels.has(uid)) labels.set(uid, "Authorized reviewer");
      }
    }
  }
  return labels;
}

// PEAKOPS_REPORT_IMG_BUNDLED_V1 (2026-05-01)
// URL-encode a relative path for use in an HTML `src=`. Encodes
// each segment with encodeURIComponent (preserving "/" separators
// and the leading ".." parent segment). Defensive coverage for
// chars the slugify/filename regex would already strip — but
// future changes to those rules shouldn't be able to silently
// emit a malformed src. Also explicitly encodes "(", ")", "'",
// which encodeURIComponent leaves alone but some local viewers
// (Finder Preview, Quick Look, certain Windows file-protocol
// handlers) can mis-tokenize.
function encodeRelPath(p) {
  return String(p || "")
    .split("/")
    .map((seg) => {
      if (seg === "" || seg === "." || seg === "..") return seg;
      return encodeURIComponent(seg)
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/'/g, "%27");
    })
    .join("/");
}

function formatDateTime(v) {
  if (!v) return "—";
  let iso;
  try {
    iso = v?.toDate?.().toISOString?.() || (typeof v === "string" ? v : null);
  } catch {
    iso = null;
  }
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString("en-US", {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

// PEAKOPS_REPORT_POLISH_V1 (2026-05-01)
// Time-only and date-only formatters for the polished timeline +
// customer doc. Timeline lines lead with "1:53 PM — Field arrived"
// and tuck the full date under it as smaller secondary text.
function _toMs(v) {
  let iso;
  try {
    iso = v?.toDate?.().toISOString?.() || (typeof v === "string" ? v : null);
  } catch { iso = null; }
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function formatTimeShort(v) {
  const ms = _toMs(v);
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
function formatDateShort(v) {
  const ms = _toMs(v);
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return "—";
  }
}

// Pick the most useful incident-level title using the same chain the
// listIncidentsV1 server-side resolver uses (title → name → first
// task title → "Untitled incident"). Avoids the customer ZIP showing
// "Untitled incident" for records whose label lives on the task.
function deriveIncidentTitle(incident, jobs) {
  const t1 = String(incident?.title || "").trim();
  if (t1) return t1;
  const t2 = String(incident?.name || incident?.displayName || "").trim();
  if (t2) return t2;
  const arr = Array.isArray(jobs) ? jobs : [];
  for (const j of arr) {
    const tt = String(j?.title || "").trim();
    if (tt) return tt;
  }
  const desc = String(incident?.description || incident?.workDescription || "").trim();
  if (desc) return desc.length > 80 ? desc.slice(0, 78) + "…" : desc;
  return "Untitled incident";
}

// Read the field-note doc + project the customer-facing fields. Falls
// back to empty / "no note" semantics gracefully when missing.
async function loadNotes(db, incidentId) {
  try {
    const ref = db.doc(`incidents/${incidentId}/notes/main`);
    const snap = await ref.get();
    if (!snap.exists) return { incidentNotes: "", siteNotes: "", notesStatus: "", notesBypassReason: "" };
    const d = snap.data() || {};
    return {
      incidentNotes: String(d.incidentNotes || "").trim(),
      siteNotes: String(d.siteNotes || "").trim(),
      notesStatus: String(d.notesStatus || "").trim().toLowerCase(),
      notesBypassReason: String(d.notesBypassReason || "").trim(),
    };
  } catch {
    return { incidentNotes: "", siteNotes: "", notesStatus: "", notesBypassReason: "" };
  }
}

// PEAKOPS_REPORT_ENGINE_V1 (2026-04-30)
// Decide the headline status banner. "APPROVED & LOCKED" is the
// strongest claim and only fires when (a) the incident is closed,
// (b) at least one task exists, (c) every task is approved, and
// (d) every approval is locked. Anything weaker reflects reality
// honestly — we never tell an auditor a record was approved when
// it wasn't.
function deriveCertificationBanner(ctx) {
  // PEAKOPS_REPORT_DEFENSIVE_V1 (2026-05-05)
  // Treat every nested ctx field as optional — a malformed incident
  // (e.g. counts not yet assembled, approvals undefined) should not
  // crash the export. Coerce to safe defaults instead.
  const safe = ctx || {};
  const counts = safe.counts || {};
  const isClosed = String(safe.incidentStatus || "").trim().toLowerCase() === "closed";
  const tasksTotal = Number(counts.tasksTotal || 0);
  const tasksApproved = Number(counts.tasksApproved || 0);
  const allApproved = tasksTotal > 0 && tasksApproved === tasksTotal;
  const approvals = Array.isArray(safe.approvals) ? safe.approvals : [];
  const allLocked = approvals.length > 0 && approvals.every((a) => !!(a && a.locked));
  const anyRejected = approvals.some(
    (a) => String((a && a.decision) || "").toLowerCase().includes("sent back"),
  );
  if (isClosed && allApproved && allLocked) {
    return { label: "Approved & locked", tone: "approved" };
  }
  if (isClosed && allApproved) {
    return { label: "Approved", tone: "approved" };
  }
  if (isClosed) {
    return { label: "Closed", tone: "neutral" };
  }
  if (anyRejected) {
    return { label: "Revisions requested", tone: "warn" };
  }
  if (tasksTotal > 0 && tasksApproved > 0) {
    return { label: "Partially approved", tone: "warn" };
  }
  if (ctx.timestamps.submitted) {
    return { label: "Submitted for review", tone: "neutral" };
  }
  return { label: "In progress", tone: "neutral" };
}

// Build the human-readable cover document. Standalone HTML — opens
// in any browser, prints cleanly. Inline CSS keeps the file
// self-contained. Lives at REPORTS/REPORT_SUMMARY.html so relative
// paths to ../evidence/<task>/<photo> resolve when the ZIP is
// extracted; browsers that can render the photo type (JPG/PNG)
// inline the actual photo, others fall back to the filename
// caption — never a broken-image symbol with no context.
function buildCoverHtml(ctx) {
  const {
    title,
    incidentId,
    orgId,
    // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
    // Operator org name (resolved from orgs/{orgId}.name by the caller).
    // null/missing → footer falls back to "Generated by PeakOps · <date>".
    orgName,
    incidentStatus,
    timestamps,
    counts,
    location,
    priority,
    notesBlock,
    tasksWithEvidence,   // [{ title, decision, approvedBy, approvedAt, locked, photos:[{bundled|unavailable}], photoCount, bundledCount }]
    // PR 99 — slot-grouped photo data driving the EVIDENCE section.
    // [{ kind:"required"|"unassigned", slug, label, index, source,
    //    satisfied, evidenceCount, directoryInPacket,
    //    photos:[{ name, label, index, relPath|unavailable, taskTitle }] }]
    slotsWithPhotos,
    // PR 103a — Acceptance Readiness projection. Drives the new
    // Acceptance Readiness section in this audit doc. Schema in
    // functions_clean/_readiness.js.
    acceptanceReadiness,
    // PR 104 — Customer Acceptance Criteria prose (string[]).
    // Informational only, never machine-evaluated. Rendered as a
    // muted bordered card below the Acceptance Readiness section.
    acceptanceCriteria,
    humanTimeline,
    generatedAt,
    // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
    // 1 on first export; >1 means this is a regenerated bundle.
    // Rendered in the audit footer when > 1.
    reportRevision,
  } = ctx;

  const banner = deriveCertificationBanner({
    incidentStatus,
    counts,
    approvals: tasksWithEvidence,
    timestamps,
  });

  const certificationCopy = (() => {
    if (banner.tone === "approved" && banner.label === "Approved & locked") {
      // PEAKOPS_REPORT_POLISH_V1 (2026-05-01)
      // Immutable-record affirmation only fires for the strongest
      // banner ("Approved & locked"): closed + every task approved +
      // every approval locked. Anything weaker would over-claim.
      return `This record represents a complete and accurate account of the work performed.
Field documentation was captured on-site and submitted for supervisor review.
Supervisor approval was recorded and the record has been locked.

This record is immutable and has not been altered since approval.`;
    }
    if (banner.tone === "approved") {
      return `This record represents a complete and accurate account of the work performed.
Field documentation was captured on-site and submitted for supervisor review.
Supervisor approval was recorded and the record has been locked.`;
    }
    if (banner.tone === "warn" && banner.label === "Revisions requested") {
      return `This record contains supervisor feedback. One or more tasks have been sent back to the field team for revision before final approval.`;
    }
    if (banner.tone === "warn") {
      return `This record is partially approved. Some tasks have completed supervisor review; others are still pending.`;
    }
    if (banner.label === "Closed") {
      return `This incident has been closed. Final approval was not recorded prior to closure.`;
    }
    if (banner.label === "Submitted for review") {
      return `Field documentation was captured on-site and submitted for supervisor review. Approval is pending.`;
    }
    return `This record is in progress. Field documentation has not yet been submitted for supervisor review.`;
  })();

  const noteSection = (() => {
    const t = String(notesBlock?.incidentNotes || "").trim();
    const s = String(notesBlock?.siteNotes || "").trim();
    const bypassed = !t && !s && (notesBlock?.notesStatus === "bypassed" || notesBlock?.notesBypassReason);
    if (bypassed) {
      return `<p class="note">No additional note provided. Photos were submitted as sufficient documentation.</p>`;
    }
    if (!t && !s) return `<p class="muted">No field note recorded.</p>`;
    let html = "";
    if (t) html += `<p class="note">${escapeHtml(t)}</p>`;
    if (s) html += `<p class="note muted"><strong>Site:</strong> ${escapeHtml(s)}</p>`;
    return html;
  })();

  // PEAKOPS_REPORT_HEADINGS_V1 (2026-05-01)
  // TASKS section — decision metadata only (title, decision pill,
  // approver label, approval timestamp, optional notes, lock pill).
  // Photos live under the dedicated EVIDENCE section so the doc has
  // a clear top-level audit hierarchy: Status → Field Note → Tasks
  // → Evidence → Timeline.
  const tasksSection = (() => {
    // PEAKOPS_REPORT_DEFENSIVE_V2 (2026-05-05) — drop null entries before iterating.
    const list = (Array.isArray(tasksWithEvidence) ? tasksWithEvidence : []).filter((t) => !!t);
    if (list.length === 0) {
      return `<p class="muted">No tasks recorded for this incident.</p>`;
    }
    return list.map((t) => {
      const meta = [];
      meta.push(`<span class="task-decision task-decision-${escapeHtml(String(t.decision || "").toLowerCase().replace(/\s+/g, "-"))}">${escapeHtml(t.decision || "—")}</span>`);
      // PEAKOPS_REPORT_LABELS_V1 (2026-05-01)
      // t.approvedBy here is the resolved display label (displayName /
      // email / role / "Authorized reviewer"), never a UID — the
      // export pipeline rewrites it before reaching this template.
      if (t.approvedBy) meta.push(`<span class="muted">by ${escapeHtml(t.approvedBy)}</span>`);
      if (t.approvedAt) meta.push(`<span class="muted">${escapeHtml(formatDateTime(t.approvedAt))}</span>`);
      if (t.locked) meta.push(`<span class="locked-pill">Locked</span>`);
      // PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04) /
      // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
      // Audit-doc vendor pill. Suffix "(archived)" when the vendor
      // is no longer active in the catalog — surfaces stale
      // assignments to the auditor without rewriting the captured
      // vendor name. Customer report intentionally never shows
      // this suffix; the customer doesn't need to see it.
      if (t.vendorName) {
        const _archivedSuffix = t.vendorArchived ? " (archived)" : "";
        meta.push(`<span class="muted">Vendor: ${escapeHtml(t.vendorName + _archivedSuffix)}</span>`);
      }
      const photos = Array.isArray(t.photos) ? t.photos : [];
      const photoCount = photos.length;
      const bundledCount = photos.filter((p) => p && !p.unavailable && p.relPath).length;
      const photoLine = photoCount === 0
        ? `<span class="muted">No evidence captured</span>`
        : `<span class="muted">${bundledCount} of ${photoCount} ${photoCount === 1 ? "photo" : "photos"} bundled — see Evidence</span>`;
      // PEAKOPS_REPORT_AUDIT_HUMANIZE_V1 (2026-05-01)
      // Humanize per-task heading the same way the customer doc
      // does. Real human task titles pass through verbatim; only
      // slug-shaped titles get rewritten.
      const auditTaskTitle = humanizeSlug(String(t.title || "").trim()) || "Untitled task";
      return `
        <section class="task-block">
          <h3 class="task-title">${escapeHtml(auditTaskTitle)}</h3>
          <div class="task-meta">${meta.join(" · ")}</div>
          ${t.notes ? `<p class="task-notes">${escapeHtml(t.notes)}</p>` : ""}
          <div class="task-photo-line">${photoLine}</div>
        </section>
      `;
    }).join("");
  })();

  // PR 99 — EVIDENCE section now groups photos by required-proof
  // slot (the snapshot-declared structure), not by task. Each
  // declared slot gets an h3 sub-heading with the requirement
  // label + ✓/✗ satisfaction status. Empty slots render as a
  // calm "no proof captured for this requirement yet" line — the
  // missing-proof state stays visible in the customer/audit doc,
  // not just in the on-disk folder + manifest. A trailing
  // "General / Unassigned proof" section renders only when there
  // are docs without a matching slot tag. Bytes live at
  // ../original-record/required-proof/{slot}/{file} or
  // ../original-record/unassigned/{file}; image src paths point
  // there. Never emits a broken <img>.
  const evidenceSection = (() => {
    const list = Array.isArray(slotsWithPhotos) ? slotsWithPhotos.filter((s) => !!s) : [];
    if (list.length === 0) {
      return `<p class="muted">No evidence captured for this incident.</p>`;
    }
    return list.map((slot) => {
      const photos = (Array.isArray(slot.photos) ? slot.photos : []).filter((p) => !!p);
      if (photos.length === 0) {
        return `
          <section class="evidence-block evidence-block-empty">
            <h3 class="evidence-task"><span class="slot-tick slot-tick-missing">✗</span> ${escapeHtml(slot.label)}</h3>
            <p class="muted">No proof captured for this requirement yet.</p>
          </section>
        `;
      }
      const grid = `<div class="task-photo-grid">${photos.map((p) => {
        const safeName = escapeHtml(String((p && p.name) || ""));
        const idxLabel = (p && p.index) ? `Photo ${p.index}` : "Photo";
        const labelExtras = [];
        if (p && p.label) labelExtras.push(escapeHtml(String(p.label)));
        if (p && p.taskTitle) labelExtras.push(`from ${escapeHtml(String(p.taskTitle))}`);
        const primary = labelExtras.length > 0
          ? `${idxLabel} — ${labelExtras.join(" · ")}`
          : idxLabel;
        if (!p || p.unavailable || !p.relPath) {
          return `<figure class="task-photo task-photo-unavailable">
            <div class="photo-fallback">Image unavailable</div>
            <figcaption class="caption-primary">${primary}</figcaption>
            <div class="caption-filename">${safeName}</div>
          </figure>`;
        }
        const encodedSrc = encodeRelPath(p.relPath);
        const altText = p.label ? `${idxLabel} — ${p.label}` : idxLabel;
        return `<figure class="task-photo">
          <img src="${escapeHtml(encodedSrc)}" alt="${escapeHtml(altText)}" loading="lazy" />
          <figcaption class="caption-primary">${primary}</figcaption>
          <div class="caption-filename">${safeName}</div>
        </figure>`;
      }).join("")}</div>`;
      const tick = slot.kind === "required"
        ? `<span class="slot-tick ${slot.satisfied ? "slot-tick-ok" : "slot-tick-missing"}">${slot.satisfied ? "✓" : "✗"}</span>`
        : `<span class="slot-tick slot-tick-unassigned">⊘</span>`;
      return `
        <section class="evidence-block">
          <h3 class="evidence-task">${tick} ${escapeHtml(slot.label)}</h3>
          ${grid}
        </section>
      `;
    }).join("");
  })();

  // PEAKOPS_REPORT_POLISH_V1 (2026-05-01)
  // Compact timeline format: lead with "1:53 PM — Field arrived"
  // (the most-scanned info — what happened, in clock time), with
  // the full date as smaller secondary text below. Renders as a
  // <ul> rather than a 2-col table — cleaner on small screens and
  // print, no awkward horizontal whitespace.
  const timelineList = (Array.isArray(humanTimeline) ? humanTimeline : [])
    .map((e) => `
      <li class="event">
        <div class="event-primary">
          <span class="event-time">${escapeHtml(formatTimeShort(e.when))}</span>
          <span class="event-sep">—</span>
          <span class="event-label">${escapeHtml(e.label || "Event")}</span>
        </div>
        <div class="event-date">${escapeHtml(formatDateShort(e.when))}</div>
      </li>
    `).join("");

  // PR 103a — Acceptance Readiness section. Always rendered on the
  // audit doc (in contrast to the customer doc, which only surfaces
  // a positive line when state is ready). Required-tier checks
  // listed with ✓/✗ ticks; encouraged-tier (currently empty in MVP)
  // listed below. State label uses the operational vocabulary —
  // "Ready for submission" / "Requirements missing" / "Not available."
  const readinessSection = (() => {
    const r = acceptanceReadiness;
    if (!r || !Array.isArray(r.checks)) return "";
    const stateLabel = {
      ready_for_submission: "Ready for submission",
      requirements_missing: "Requirements missing",
      not_available: "Not available",
    }[r.state] || r.state;
    const stateTone = {
      ready_for_submission: "approved",
      requirements_missing: "warn",
      not_available: "neutral",
    }[r.state] || "neutral";
    // PR 104 — explicit filters. "unknown" satisfaction (template_check_unknown
    // rows) routes into its own subsection, not required/encouraged.
    const requiredChecks = r.checks.filter(
      (c) => c.tier === "required" && (c.satisfied === true || c.satisfied === false),
    );
    const encouragedChecks = r.checks.filter(
      (c) => c.tier === "encouraged" && (c.satisfied === true || c.satisfied === false),
    );
    const unknownChecks = r.checks.filter((c) => c.satisfied === "unknown");
    const renderRow = (c) => {
      // PR 104 — three-way tick. Truthy check would render "unknown"
      // (a string) as ✓ — wrong. Explicit comparison required.
      let tick;
      if (c.satisfied === true) {
        tick = `<span class="readiness-tick readiness-tick-ok">✓</span>`;
      } else if (c.satisfied === false) {
        tick = `<span class="readiness-tick readiness-tick-missing">✗</span>`;
      } else {
        tick = `<span class="readiness-tick readiness-tick-unknown">⚠</span>`;
      }
      const detail = c.detail
        ? `<span class="readiness-detail muted">${escapeHtml(c.detail)}</span>`
        : "";
      return `<li class="readiness-row">${tick}<span class="readiness-label">${escapeHtml(c.label)}</span>${detail}</li>`;
    };
    const counts = r.summary;
    const countLine = `${counts.requiredSatisfied} / ${counts.requiredTotal} required satisfied${
      counts.encouragedTotal > 0
        ? ` · ${counts.encouragedSatisfied} / ${counts.encouragedTotal} encouraged`
        : ""
    }${
      // PR 104 — surface unknown count in the header strip so the
      // auditor sees at a glance whether the runtime evaluated
      // everything the template declared.
      unknownChecks.length > 0
        ? ` · ${unknownChecks.length} unknown`
        : ""
    }`;
    return `
      <div class="readiness-header readiness-tone-${stateTone}">
        <span class="readiness-state">${escapeHtml(stateLabel)}</span>
        <span class="readiness-counts">${escapeHtml(countLine)}</span>
      </div>
      ${requiredChecks.length === 0 ? "" : `
        <h3 class="readiness-tier">Required</h3>
        <ul class="readiness-list">${requiredChecks.map(renderRow).join("")}</ul>
      `}
      ${encouragedChecks.length === 0 ? "" : `
        <h3 class="readiness-tier">Encouraged</h3>
        <ul class="readiness-list">${encouragedChecks.map(renderRow).join("")}</ul>
      `}
      ${unknownChecks.length === 0 ? "" : `
        <h3 class="readiness-tier">Unknown</h3>
        <ul class="readiness-list">${unknownChecks.map(renderRow).join("")}</ul>
      `}
    `;
  })();

  // PR 104 — Customer Acceptance Criteria prose block. Renders ONLY
  // when the snapshot carries non-empty acceptanceCriteria.
  // Approved decision §7. Informational, never machine-evaluated.
  const criteriaSection = (() => {
    const list = Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map((s) => String(s || "").trim()).filter((s) => s.length > 0)
      : [];
    if (list.length === 0) return "";
    return `
      <div class="acceptance-criteria-block">
        <h3>Customer Acceptance Criteria</h3>
        <p class="criteria-note">Stated by the customer template — not machine-evaluated.</p>
        <ul>
          ${list.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
        </ul>
      </div>
    `;
  })();

  const bannerColor = {
    approved: { bg: "#e8f5ee", border: "#a8d5b8", fg: "#1f6d3a" },
    warn:     { bg: "#fff8e1", border: "#e6cf83", fg: "#7a5a00" },
    neutral:  { bg: "#f1f3f5", border: "#d0d7de", fg: "#3a3f44" },
  }[banner.tone] || { bg: "#f1f3f5", border: "#d0d7de", fg: "#3a3f44" };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- AUDIT_TITLE_FIX_V3 -->
<!-- EXPORT_SOURCE_PROOF_V4 file=functions_clean/exportIncidentPacketV1.js -->
<title>Incident Report — ${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1c1c1c; background: #ffffff; margin: 0;
    padding: 32px 40px 64px; line-height: 1.55; max-width: 880px;
  }
  h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.01em; }
  .subtitle {
    margin: 0 0 4px; font-size: 14px; color: #555;
    display: flex; flex-wrap: wrap; gap: 12px;
  }
  .subtitle .id { font-size: 11px; color: #999; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  /* PEAKOPS_REPORT_HEADINGS_V1 (2026-05-01)
     h2 = top-level audit section (Status, Field Note, Tasks, Evidence,
     Timeline). h3 = sub-heading inside a section (task title inside
     Tasks, per-task evidence group inside Evidence). The visual gap
     between the two levels makes the audit hierarchy scannable on
     paper or screen. */
  h2 {
    margin: 32px 0 10px; font-size: 13px; letter-spacing: 0.14em;
    text-transform: uppercase; color: #1c1c1c;
    border-bottom: 2px solid #1c1c1c; padding-bottom: 6px;
  }
  h3.task-title, h3.evidence-task {
    margin: 0 0 4px; font-size: 15px; letter-spacing: 0;
    text-transform: none; color: #1c1c1c; border: 0; padding: 0;
  }
  h3.evidence-task { margin: 18px 0 6px; font-size: 13px; color: #444; }

  /* Certification block */
  .cert {
    margin: 18px 0 22px; padding: 14px 16px; border-radius: 8px;
    border: 1px solid ${bannerColor.border}; background: ${bannerColor.bg};
    color: ${bannerColor.fg};
  }
  .cert .status-line {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  }
  .cert .status-label {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: ${bannerColor.fg};
    opacity: 0.85;
  }
  .cert .status-value {
    font-size: 18px; font-weight: 800; letter-spacing: 0.02em;
    text-transform: uppercase; color: ${bannerColor.fg};
  }
  .cert .copy {
    margin: 8px 0 0; font-size: 13px; line-height: 1.55; white-space: pre-line;
    color: #2a2a2a;
  }

  /* Stats row */
  .summary-counts {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    margin: 6px 0 0;
  }
  .summary-counts .cell {
    border: 1px solid #e5e5e5; border-radius: 6px;
    padding: 10px 12px; background: #fafafa;
  }
  .summary-counts .cell .num { font-size: 22px; font-weight: 700; }
  .summary-counts .cell .label { font-size: 10px; color: #666;
    letter-spacing: 0.06em; text-transform: uppercase; margin-top: 2px; }

  /* Stamps row */
  .stamps {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    margin: 12px 0 0;
  }
  .stamps .stamp {
    border: 1px dashed #e0e0e0; border-radius: 6px; padding: 8px 10px;
    background: #fff;
  }
  .stamps .stamp .label { font-size: 9px; color: #777; letter-spacing: 0.10em;
    text-transform: uppercase; }
  .stamps .stamp .value { font-size: 12px; color: #1c1c1c; margin-top: 2px; }

  /* Note */
  .note { margin: 6px 0; white-space: pre-wrap; font-size: 13px; }
  .muted { color: #777; }

  /* Tasks */
  .task-block {
    margin: 16px 0; padding: 14px 16px; border-radius: 8px;
    border: 1px solid #e5e5e5; background: #fcfcfd;
  }
  .task-meta {
    margin: 4px 0 8px; font-size: 12px; color: #555;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  .task-decision {
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; padding: 2px 8px; border-radius: 999px;
    background: #eef0f2; color: #2a2a2a;
  }
  .task-decision-approved { background: #e8f5ee; color: #1f6d3a; }
  .task-decision-sent-back { background: #fbeaea; color: #8a2a2a; }
  .task-decision-in-review { background: #fff8e1; color: #7a5a00; }
  .locked-pill {
    font-size: 9px; letter-spacing: 0.10em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 4px; background: #1c1c1c; color: #fff;
  }
  .task-notes {
    margin: 6px 0 10px; font-size: 12px; color: #444; white-space: pre-wrap;
    padding: 8px 10px; border-left: 3px solid #d0d7de; background: #fff;
  }
  .task-no-photos {
    margin-top: 6px; font-size: 12px; padding: 8px 10px;
    border: 1px dashed #e5e5e5; border-radius: 6px;
  }
  .task-photo-line { margin-top: 6px; font-size: 12px; }
  .evidence-block { margin: 0 0 18px; }
  /* PR 103a — Acceptance Readiness section. State header reads as
     a single horizontal strip: state label + counts. Checks render
     as a tight list with ✓ / ✗ ticks. Tones use the existing
     banner palette (approved/warn/neutral) for visual coherence. */
  .readiness-header {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 8px 12px; border-radius: 6px; margin-bottom: 12px;
    font-size: 13px;
  }
  .readiness-tone-approved { background: #e8f5ee; border: 1px solid #a8d5b8; color: #1f6d3a; }
  .readiness-tone-warn { background: #fff8e1; border: 1px solid #e6cf83; color: #7a5a00; }
  .readiness-tone-neutral { background: #f1f3f5; border: 1px solid #d0d7de; color: #3a3f44; }
  .readiness-state { font-weight: 600; }
  .readiness-counts { font-size: 12px; opacity: 0.85; }
  .readiness-tier { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
  .readiness-list { list-style: none; padding: 0; margin: 0; }
  .readiness-row { display: grid; grid-template-columns: 20px 1fr auto; gap: 8px; padding: 4px 0; font-size: 13px; align-items: baseline; }
  .readiness-tick-ok { color: #1f6d3a; }
  .readiness-tick-missing { color: #c14545; }
  /* PR 104 — Unknown acceptance check (template referenced a type
     the current backend doesn't recognize). Renders neutral amber
     ⚠ glyph; does NOT influence state. */
  .readiness-tick-unknown { color: #7a5a00; }
  /* PR 104 — Customer Acceptance Criteria prose block (informational
     only, never machine-evaluated). Muted bordered card so it reads
     as context, not a checklist. */
  .acceptance-criteria-block {
    margin: 16px 0 24px;
    padding: 12px 14px;
    background: #fafafa;
    border: 1px solid #e5e5e5;
    border-radius: 6px;
  }
  .acceptance-criteria-block h3 {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .acceptance-criteria-block .criteria-note {
    margin: 0 0 8px;
    font-size: 11px;
    color: #777;
    font-style: italic;
  }
  .acceptance-criteria-block ul { margin: 0; padding-left: 18px; font-size: 13px; }
  .acceptance-criteria-block li { margin: 2px 0; color: #1c1c1c; }
  .readiness-label { color: #1c1c1c; }
  .readiness-detail { font-size: 11px; }
  .task-photo-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px; margin-top: 8px;
  }
  .task-photo {
    margin: 0; border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden;
    background: #f5f5f5;
  }
  .task-photo img {
    display: block; width: 100%; height: 130px; object-fit: cover;
  }
  .task-photo-unavailable .photo-fallback {
    display: flex; align-items: center; justify-content: center;
    height: 130px; font-size: 11px; color: #888;
    background: #f5f5f5; text-align: center; padding: 0 12px;
  }
  /* PEAKOPS_REPORT_POLISH_V1 (2026-05-01) Caption hierarchy:
     primary = "Photo N" (or "Photo N — Label"), filename smaller. */
  .task-photo .caption-primary {
    font-size: 11px; color: #1c1c1c; padding: 4px 8px 0;
    font-weight: 500; background: #fff;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .task-photo .caption-filename {
    font-size: 9px; color: #888; padding: 0 8px 4px; background: #fff;
    border-top: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Timeline (compact list — no table) */
  .event-list { list-style: none; margin: 0; padding: 0; }
  .event-list .event {
    padding: 8px 0; border-top: 1px solid #f0f0f0;
  }
  .event-list .event:first-child { border-top: 0; }
  .event-primary {
    display: flex; gap: 8px; align-items: baseline; font-size: 13px;
    color: #1c1c1c;
  }
  .event-time {
    font-variant-numeric: tabular-nums; font-weight: 600;
    color: #1c1c1c; min-width: 56px;
  }
  .event-sep { color: #bbb; }
  .event-label { color: #1c1c1c; }
  .event-date { font-size: 10px; color: #888; margin-top: 2px; padding-left: 64px; }

  footer { margin-top: 36px; font-size: 10px; color: #888;
           border-top: 1px solid #e5e5e5; padding-top: 12px; }
  footer .footer-line { margin-bottom: 2px; }
  footer .footer-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #999; }
  /* PEAKOPS_REPORT_LINEAGE_V1_1 (2026-05-04) */
  footer .footer-revision { margin-top: 4px; font-size: 10px; color: #888; }

  @media print {
    body { padding: 24px; }
    h2, h3 { page-break-after: avoid; }
    .task-block, .task-photo, .cert, .summary-counts .cell, .evidence-block { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="subtitle">
  ${location ? `<span>${escapeHtml(location)}</span>` : ""}
  <span>${escapeHtml(formatDateTime(timestamps?.closed || timestamps?.approved || timestamps?.submitted || timestamps?.created))}</span>
  <span class="id">${escapeHtml(incidentId)}</span>
</div>

<h2>Status</h2>
<div class="cert">
  <div class="status-line">
    <span class="status-label">Status</span>
    <span class="status-value">${escapeHtml(banner.label)}</span>
  </div>
  <p class="copy">${escapeHtml(certificationCopy)}</p>
</div>

<div class="summary-counts">
  <div class="cell"><div class="num">${counts.tasksApproved}/${counts.tasksTotal}</div><div class="label">Tasks Approved</div></div>
  <div class="cell"><div class="num">${counts.tasksCompleted}</div><div class="label">Tasks Completed</div></div>
  <div class="cell"><div class="num">${counts.evidence}</div><div class="label">Photos Captured</div></div>
  <div class="cell"><div class="num">${(tasksWithEvidence || []).filter((t) => t && t.locked).length}</div><div class="label">Locked Approvals</div></div>
</div>

<div class="stamps">
  <div class="stamp"><div class="label">Submitted</div><div class="value">${escapeHtml(formatDateTime(timestamps?.submitted))}</div></div>
  <div class="stamp"><div class="label">Approved</div><div class="value">${escapeHtml(formatDateTime(timestamps?.approved))}</div></div>
  <div class="stamp"><div class="label">Closed</div><div class="value">${escapeHtml(formatDateTime(timestamps?.closed))}</div></div>
  <div class="stamp"><div class="label">Organization</div><div class="value">${escapeHtml(orgId)}</div></div>
</div>

<h2>Acceptance Readiness</h2>
${readinessSection}
${criteriaSection}

<h2>Field Note</h2>
${noteSection}

<h2>Tasks</h2>
${tasksSection}

<h2>Evidence</h2>
${evidenceSection}

<h2>Timeline</h2>
${humanTimeline.length === 0
  ? `<p class="muted">No timeline events recorded.</p>`
  : `<ul class="event-list">${timelineList}</ul>`
}

<footer>
  <div class="footer-line">Report ID: <span class="footer-id">${escapeHtml(incidentId)}</span></div>
  <div class="footer-line">${
    /* PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22) */
    orgName && String(orgName).trim()
      ? `Generated by ${escapeHtml(String(orgName).trim())} · powered by PeakOps · ${escapeHtml(formatDateTime(generatedAt))}`
      : `Generated by PeakOps · ${escapeHtml(formatDateTime(generatedAt))}`
  }</div>
  <div class="footer-revision">Revision: ${escapeHtml(String(Number(reportRevision) || 1))}</div>
</footer>
</body>
</html>`;
}

// PEAKOPS_REPORT_CUSTOMER_POLISH_V1 (2026-05-01)
// Humanize a system-ID-shaped title for the CUSTOMER doc only.
// Examples:
//   "inc_run_035_customer_report_test" → "Customer Report Test"
//   "Replace_damaged_insulator"        → "Replace Damaged Insulator"
//   "Tighten guy wire anchor"          → unchanged (already human)
//   "Tower 41-B inspection"            → unchanged
// If the incident's resolved title looks system-shaped, also try
// to use a cleaner task title first — the spec says "prefer task
// title if cleaner than incident displayTitle". The audit doc
// keeps the raw title for traceability.
function _looksSystemId(s) {
  const v = String(s || "").trim();
  if (!v) return false;
  if (/^inc_run_\d+/i.test(v)) return true;
  // Pure slug shape: only [A-Za-z0-9_-] AND contains "_". Spaces or
  // punctuation in the title means it's already meant for humans.
  if (/^[A-Za-z0-9_-]+$/.test(v) && v.includes("_")) return true;
  return false;
}
// PEAKOPS_REPORT_CUSTOMER_POLISH_V2 (2026-05-01)
// Single-string slug humanizer. Called directly on per-task titles
// in the customer doc (Work Completed sentence, Photos h3) so a
// task with a slug-shaped title doesn't leak the slug into the
// customer-facing body. Returns the input verbatim for non-slug
// inputs — never over-rewrites a real human title.
function humanizeSlug(s) {
  const v = String(s || "").trim();
  if (!v) return v;
  if (!_looksSystemId(v)) return v;
  let out = v.replace(/^inc_run_\d+_*/i, "");
  out = out.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!out) return v;
  return out
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
function humanizeCustomerTitle(rawTitle, tasksWithEvidence) {
  const main = String(rawTitle || "").trim();
  if (!_looksSystemId(main)) return main;
  // Step 1: try to use a cleaner task title (one that's not also
  // slug-shaped).
  const cleanerTask = (Array.isArray(tasksWithEvidence) ? tasksWithEvidence : [])
    .filter((t) => !!t)
    .map((t) => String(t.title || "").trim())
    .find((tt) => tt && !_looksSystemId(tt));
  if (cleanerTask) return cleanerTask;
  // Step 2: humanize the slug. Same logic as humanizeSlug, kept
  // inline here so this helper stays self-contained for callers
  // that don't need the per-task fallback.
  return humanizeSlug(main);
}

// PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
// Customer-facing variant of the incident report. Same evidence
// files as the audit doc (relative paths into ../evidence/...) so
// the ZIP carries one set of bytes and two HTMLs that read them.
//
// Constraints (from spec):
//   - friendlier, plainer language than the audit doc
//   - hide internal IDs from the body (incidentId only in small
//     footer for traceability)
//   - hide orgId entirely
//   - no audit/system vocabulary: no "packet", "artifact", "job",
//     "actor", "ref", "storagePath", "bucket"
//   - sections: Work Completed, Notes, Photos, Completed & Approved
//   - "Generated by PeakOps" footer
//
// What stays the same as the audit doc: the bundled photo paths
// (`../evidence/<slug>/<NN>__<stem>.<ext>`), the URL-encoding
// helper for src, the "Image unavailable" tile for skipped
// photos. The browser only ever opens local files — never any
// API, never any auth.
function buildCustomerHtml(ctx) {
  const {
    title: rawTitle,
    incidentId,
    // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
    // Operator org name (resolved by caller). null → footer falls
    // back to "Generated by PeakOps · <date>".
    orgName,
    timestamps,
    location,
    notesBlock,
    tasksWithEvidence,
    // PR 99 — slot-grouped photo data for the Photos section.
    slotsWithPhotos,
    // PR 103a — Acceptance Readiness. On the customer doc we ONLY
    // surface a positive line when the state is
    // "ready_for_submission" (per approved scope: customer-facing
    // never displays a missing-items checklist).
    acceptanceReadiness,
    generatedAt,
    // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
    reportRevision,
  } = ctx;

  // PEAKOPS_REPORT_CUSTOMER_POLISH_V1 (2026-05-01)
  // Customer doc applies the slug-stripper. Audit doc receives
  // the raw resolved title separately and never goes through
  // this helper.
  const title = humanizeCustomerTitle(rawTitle, tasksWithEvidence);

  // PEAKOPS_REPORT_DEFENSIVE_V2 (2026-05-05) — drop null entries before iterating.
  const list = (Array.isArray(tasksWithEvidence) ? tasksWithEvidence : []).filter((t) => !!t);

  // Tasks the customer cares about: anything that was approved or
  // completed. Tasks still in review/sent back are intentionally
  // omitted from "Work Completed" so the doc never claims work was
  // finished when it wasn't.
  const completedTasks = list.filter((t) => {
    const d = String((t && t.decision) || "").toLowerCase();
    return d === "approved" || d === "complete";
  });

  // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
  // Spec asks for a short paragraph, not a bulleted list — reads
  // friendlier, fits a one-page customer summary. We render the
  // task titles inline as a sentence ("X, Y, and Z."). For a single
  // task we drop the list entirely. For >1 we use an Oxford-style
  // join. No invented prose — just the resolved task titles.
  const workCompletedHtml = (() => {
    // PEAKOPS_REPORT_CUSTOMER_POLISH_V2 (2026-05-01)
    // Humanize each task title before composing the sentence —
    // otherwise a slug-shaped task title leaks into the customer
    // copy ("inc_run_036_customer_polish was completed.").
    const titles = completedTasks
      .map((t) => humanizeSlug(String(t.title || "").trim()))
      .filter(Boolean);
    if (titles.length === 0) {
      return `<p class="muted">No work has been marked complete yet.</p>`;
    }
    if (titles.length === 1) {
      return `<p>${escapeHtml(titles[0])} was completed.</p>`;
    }
    const last = titles[titles.length - 1];
    const head = titles.slice(0, -1).join(", ");
    return `<p>The following work was completed: ${escapeHtml(head)}, and ${escapeHtml(last)}.</p>`;
  })();

  const notesHtml = (() => {
    const t = String(notesBlock?.incidentNotes || "").trim();
    const s = String(notesBlock?.siteNotes || "").trim();
    const bypassed = !t && !s && (notesBlock?.notesStatus === "bypassed" || notesBlock?.notesBypassReason);
    if (bypassed) {
      return `<p>Photos document the work performed.</p>`;
    }
    if (!t && !s) return `<p class="muted">No notes recorded.</p>`;
    let html = "";
    if (t) html += `<p>${escapeHtml(t)}</p>`;
    if (s) html += `<p class="muted"><strong>Site:</strong> ${escapeHtml(s)}</p>`;
    return html;
  })();

  // PR 99 — Customer Photos section now groups by required-proof
  // slot (matches audit doc + on-disk layout). Each declared slot
  // shows the requirement label as a heading, with captured photos
  // beneath. Empty slots render a calm "no photos captured for this
  // requirement yet" line so the customer can see what was asked
  // for vs. what was delivered. A trailing "General / Unassigned
  // photos" section appears only when applicable.
  const photosHtml = (() => {
    const groups = Array.isArray(slotsWithPhotos) ? slotsWithPhotos.filter((s) => !!s) : [];
    if (groups.length === 0) {
      return `<p class="muted">No photos were captured.</p>`;
    }
    return groups.map((slot) => {
      const photos = (Array.isArray(slot.photos) ? slot.photos : []).filter((p) => !!p);
      const heading = escapeHtml(slot.label);
      if (photos.length === 0) {
        return `
          <section class="cust-photo-block cust-photo-block-empty">
            <h3>${heading}</h3>
            <p class="muted">No photos captured for this requirement yet.</p>
          </section>
        `;
      }
      const grid = photos.map((p) => {
        const safeName = escapeHtml(String((p && p.name) || ""));
        const idxLabel = (p && p.index) ? `Photo ${p.index}` : "Photo";
        const primary = (p && p.label)
          ? `${idxLabel} — ${escapeHtml(String(p.label))}`
          : idxLabel;
        if (!p || p.unavailable || !p.relPath) {
          return `<figure class="cust-photo cust-photo-unavailable">
            <div class="photo-fallback">Image unavailable</div>
            <figcaption>${primary}</figcaption>
          </figure>`;
        }
        const encodedSrc = encodeRelPath(p.relPath);
        const altText = p.label ? `${idxLabel} — ${p.label}` : idxLabel;
        return `<figure class="cust-photo">
          <img src="${escapeHtml(encodedSrc)}" alt="${escapeHtml(altText)}" loading="lazy" />
          <figcaption>${primary}</figcaption>
          <div class="cust-photo-filename">${safeName}</div>
        </figure>`;
      }).join("");
      return `
        <section class="cust-photo-block">
          <h3>${heading}</h3>
          <div class="cust-photo-grid">${grid}</div>
        </section>
      `;
    }).join("");
  })();

  // Approval rollup. Use the resolved approver labels (no UIDs).
  const approverLabels = (() => {
    const set = new Set();
    for (const t of list) {
      const v = String(t.approvedBy || "").trim();
      if (v) set.add(v);
    }
    return Array.from(set);
  })();

  // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
  // Per spec: lead with the literal sentence "Work completed and
  // approved." — same wording regardless of approver / date detail
  // available. The optional date and approver still render below
  // in smaller secondary text for traceability, but the customer
  // reads the friendly sentence first.
  const approvalLine = (() => {
    const totalCompleted = completedTasks.length;
    if (totalCompleted === 0) {
      return `<p>This work is in progress.</p>`;
    }
    const approvedAt = timestamps?.approved || timestamps?.closed || null;
    const detailParts = [];
    if (approvedAt) detailParts.push(`Approved on ${escapeHtml(formatDateShort(approvedAt))}`);
    if (approverLabels.length > 0) detailParts.push(`by ${escapeHtml(approverLabels.join(", "))}`);
    const detailLine = detailParts.length === 0
      ? ""
      : `<div class="cust-approver">${detailParts.join(" ")}.</div>`;
    return `<p>Work completed and approved.</p>${detailLine}`;
  })();

  // PR 103a — Customer-facing readiness line. Renders ONLY when
  // every required check is satisfied. Pre-positive states are
  // omitted entirely from the customer doc (per approved scope:
  // customer-facing never surfaces a missing-items checklist —
  // would undermine the closeout claim).
  const readinessReadyLine = (() => {
    if (!acceptanceReadiness || acceptanceReadiness.state !== "ready_for_submission") return "";
    return `
      <div class="cust-readiness">
        <p>All required acceptance signals satisfied at the time this packet was generated.</p>
      </div>
    `;
  })();

  const headerDate = formatDateShort(
    timestamps?.closed || timestamps?.approved || timestamps?.submitted || timestamps?.created,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Work Summary — ${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1c1c1c; background: #ffffff; margin: 0;
    padding: 40px 44px 64px; line-height: 1.6; max-width: 820px;
  }
  h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.01em; }
  /* PEAKOPS_REPORT_CUSTOMER_POLISH_V2 (2026-05-01)
     Subtitle is now a single paragraph reading "Site: <site> · <date>"
     (or just "<date>" if there's no site). Replaces the previous
     two-span subtitle row. */
  .cust-site {
    margin: 0 0 20px; font-size: 14px; color: #555;
  }
  h2 {
    margin: 32px 0 10px; font-size: 16px; letter-spacing: 0.02em;
    color: #1c1c1c; border-bottom: 1px solid #e5e5e5; padding-bottom: 6px;
    font-weight: 600;
  }
  p { margin: 6px 0; font-size: 14px; }
  .muted { color: #777; }

  .work-list { margin: 6px 0 0; padding-left: 20px; font-size: 14px; }
  .work-list li { margin: 4px 0; }

  .cust-approver { margin-top: 4px; font-size: 13px; color: #555; }
  /* PR 103a — Customer-facing readiness positive-line styling. Calm
     green tone, never alarmist. Renders only when state is
     ready_for_submission. */
  .cust-readiness {
    margin-top: 10px; padding: 8px 12px; border-radius: 6px;
    background: #f0f7f2; border: 1px solid #c9e4d3; color: #1f6d3a;
    font-size: 13px;
  }
  .cust-readiness p { margin: 0; font-size: 13px; }

  .cust-photo-block { margin: 14px 0 20px; }
  /* PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04) */
  .cust-provider {
    margin: -2px 0 8px; font-size: 12px; color: #6f6f6f;
  }
  .cust-provider span { color: #1c1c1c; font-weight: 500; }
  .cust-photo-block h3 {
    margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #444;
  }
  .cust-photo-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  .cust-photo {
    margin: 0; border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden;
    background: #f5f5f5;
  }
  .cust-photo img {
    display: block; width: 100%; height: 150px; object-fit: cover;
  }
  .cust-photo figcaption {
    font-size: 12px; color: #1c1c1c; padding: 6px 10px 0;
    background: #fff; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cust-photo-filename {
    font-size: 9px; color: #999; padding: 0 10px 6px; background: #fff;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cust-photo-unavailable .photo-fallback {
    display: flex; align-items: center; justify-content: center;
    height: 150px; font-size: 11px; color: #888; background: #f5f5f5;
    text-align: center; padding: 0 12px;
  }

  /* PEAKOPS_REPORT_CUSTOMER_POLISH_V1 (2026-05-01)
     Footer: lead with the "Generated by PeakOps · <date>" line at
     normal footer size, then a clearly-separated smaller line below
     for Report ID. Visual hierarchy keeps the customer-friendly
     credit prominent and the traceability ID subordinate. */
  footer {
    margin-top: 40px; font-size: 10px; color: #888;
    border-top: 1px solid #e5e5e5; padding-top: 12px;
  }
  footer .footer-line { margin-bottom: 0; }
  /* PEAKOPS_REPORT_LINEAGE_V1_1 (2026-05-04)
     Same shape as the audit doc's .footer-revision class so both
     reports render the revision line identically — small dim caption
     below the Report ID. (Backticks intentionally avoided here: this
     comment sits inside a JS template literal and a bare backtick
     would prematurely terminate the literal, causing
     buildCustomerHtml to throw at runtime — see PR 100 fix.) */
  footer .footer-revision { margin-top: 4px; font-size: 10px; color: #888; }
  footer .footer-id-line {
    margin-top: 10px; font-size: 9px; color: #aaa;
    line-height: 1.4;
  }
  footer .footer-id {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #aaa;
  }

  @media print {
    body { padding: 28px; }
    h2, h3 { page-break-after: avoid; }
    .cust-photo, .cust-photo-block { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="cust-site">${
  location
    ? `Site: ${escapeHtml(location)} · ${escapeHtml(headerDate)}`
    : `${escapeHtml(headerDate)}`
}</p>

<h2>Work Completed</h2>
${workCompletedHtml}

<h2>Notes</h2>
${notesHtml}

<h2>Photos</h2>
${photosHtml}

<h2>Completed and Approved</h2>
${approvalLine}
${readinessReadyLine}

<footer>
  <div class="footer-line">${
    /* PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22) */
    orgName && String(orgName).trim()
      ? `Generated by ${escapeHtml(String(orgName).trim())} · powered by PeakOps · ${escapeHtml(formatDateTime(generatedAt))}`
      : `Generated by PeakOps · ${escapeHtml(formatDateTime(generatedAt))}`
  }</div>
  <div class="footer-id-line">Report ID: <span class="footer-id">${escapeHtml(incidentId)}</span></div>
  <div class="footer-revision">Revision: ${escapeHtml(String(Number(reportRevision) || 1))}</div>
</footer>
</body>
</html>`;
}


exports.exportIncidentPacketV1 = onRequest({ cors: true }, async (req, res) => {
  // PEAKOPS_EXPORT_SOURCE_PROOF_V4 (2026-05-01)
  // Deploy-state probe. If you see this line in firebase functions:log,
  // the running function is loading from
  // my-app/functions_clean/exportIncidentPacketV1.js. Pairs with the
  // <!-- EXPORT_SOURCE_PROOF_V4 --> marker in the audit HTML output.
  // eslint-disable-next-line no-console
  console.log("[EXPORT_SOURCE_PROOF] file=functions_clean/exportIncidentPacketV1.js marker=V4");
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: report packet export is admin-or-supervisor
    // only. Reports leave the org boundary as artifacts (audit-ready
    // PDFs, evidence bundles), so the gate must run before the
    // incident or evidence reads to prevent a non-member from
    // discovering whether an incident even exists.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_GENERATE_REPORT);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[exportIncidentPacketV1] authz_denied", {
        fn: "exportIncidentPacketV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_GENERATE_REPORT,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[exportIncidentPacketV1] authz_ok", {
      fn: "exportIncidentPacketV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_GENERATE_REPORT,
    });

    // PEAKOPS_ENTITLEMENT_GATE_V1 (2026-05-13)
    // Sprint 1 entitlement spine: gate signed-packet generation on
    // the riskDefenseModule entitlement. Runs immediately after
    // orgId/incidentId validation and before any Firestore reads.
    // Failure paths return 402 + structured { reason, featureKey }
    // so the client surfaces the right UpgradePrompt copy. No
    // artifact logic is touched.
    try {
      await requireEntitlement(orgId, "riskDefenseModule");
    } catch (e) {
      console.warn("[exportIncidentPacketV1] entitlement_denied", {
        fn: "exportIncidentPacketV1",
        orgId,
        incidentId,
        featureKey: "riskDefenseModule",
        reason: (e && e.details && e.details.reason) || null,
        code: e && e.code,
      });
      return j(res, httpStatusFromEntitlementError(e), {
        ok: false,
        error: (e && e.details && e.details.reason) || "entitlement_required",
        featureKey: "riskDefenseModule",
      });
    }
    console.log("[exportIncidentPacketV1] entitlement_ok", {
      fn: "exportIncidentPacketV1",
      orgId,
      incidentId,
      featureKey: "riskDefenseModule",
    });

    const db = getFirestore();
    let incRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let incSnap = await incRef.get();
    if (!incSnap.exists) {
      incRef = db.collection("incidents").doc(incidentId);
      incSnap = await incRef.get();
    }
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });

    // PEAKOPS_TENANT_ISOLATION_V1 (Chunk 1, 2026-06-22)
    // Centralized guard in functions_clean/_authz.js. Returns 404 on
    // mismatch so the response is indistinguishable from a nonexistent
    // incident and does not confirm the foreign incident's existence.
    // Original inline check (PR — 2026-06-15) hoisted to the shared
    // helper as part of Chunk 1: Trust Foundation.
    const _iso = assertIncidentBelongsToOrg(incSnap, orgId, {
      fn: "exportIncidentPacketV1",
      incidentId,
      actorUid,
    });
    if (!_iso.match) {
      return j(res, 404, { ok: false, error: "incident_not_found" });
    }

    // PEAKOPS_EXPORT_PATH_ALIGN_V1
    // Subcollections on this app are split across two parents. Writers that
    // hardcode the legacy top-level path:
    //   - createJobV1         → incidents/{id}/jobs
    //   - addEvidenceV1       → incidents/{id}/evidence_locker   (via evidenceRefs.mjs)
    //   - assignEvidenceToJobV1, setEvidenceLabelV1 → same legacy path
    // Timeline events are written through the unified emitTimelineEvent
    // resolver (functions_clean/_incidentPath.js), which lands them under the
    // incident doc that *actually exists* — canonical for createIncidentV1
    // incidents, legacy for seed-era incidents. Reading all three subcollections
    // off the same resolved incRef (as the original code did) produces empty
    // jobs + evidence arrays for any hybrid incident (canonical doc + legacy
    // subcollections), which is the normal shape for createIncidentV1 output.
    // Fix: read each subcollection from the parent its writers actually target.
    const legacyIncRef = db.collection("incidents").doc(incidentId);
    // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
    // Pull org vendors alongside the existing reads so we can resolve
    // archived status for each task's assigned vendor in one pass.
    // Reads orgs/{orgId}/vendors regardless of whether the incident
    // doc lives org-scoped or top-level — the vendor catalog is
    // always org-scoped.
    const [jobsSnap, evSnap, tlSnap, vendorsSnap] = await Promise.all([
      legacyIncRef.collection("jobs").get(),
      legacyIncRef.collection("evidence_locker").get(),
      incRef.collection("timeline_events").get(),
      db.collection("orgs").doc(orgId).collection("vendors").get(),
    ]);

    const incident = { id: incSnap.id, ...incSnap.data() };

    // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
    // Best-effort org-name lookup so the packet's "Generated by …"
    // footer/README can carry the operator's brand instead of the
    // generic "PeakOps". Legacy records without an orgId-resolvable
    // org doc (or orgs that have been archived) fall through to the
    // pre-3B-2 string. Never throws — packet generation continues
    // regardless.
    let _packetOrgName = null;
    try {
      const _orgDoc = await db.doc(`orgs/${orgId}`).get();
      if (_orgDoc.exists) {
        const _n = String((_orgDoc.data() || {}).name || "").trim();
        if (_n) _packetOrgName = _n;
      }
    } catch (_e) { /* fall through to default branding */ }

    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Sort docs by id so subsequent reads produce the same ordering
    // even though Firestore doesn't guarantee insertion order. No
    // index required — client-side string sort on the doc id.
    const jobs = jobsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
    // Monotonic revision counter on the incident. First export →
    // revision 1. Each regenerate bumps by 1 and is stamped on the
    // packet metadata + both manifests + the audit footer (when > 1).
    // Read from the existing packetMeta so re-exports across deploys
    // pick up the right number; fall back to 0 when missing.
    const _existingRevision = (() => {
      const v = (incident && incident.packetMeta && incident.packetMeta.reportRevision);
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    const reportRevision = _existingRevision + 1;

    // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
    // Resolve the export caller's display label via Firebase Auth.
    // Strict displayName → email fallback — no role label, no UID.
    // Used as `generatedBy` on the new history entry; may be empty
    // when the caller can't be resolved (e.g., a programmatic call
    // with no auth token), in which case the entry omits the field
    // rather than substituting a generic label.
    const _reqUid = String(body.actorUid || body.requestedBy || "").trim();
    let _generatedByLabel = "";
    if (_reqUid) {
      try {
        const _u = await admin.auth().getUser(_reqUid);
        _generatedByLabel =
          String(_u?.displayName || "").trim() ||
          String(_u?.email || "").trim() ||
          "";
      } catch {
        // Auth lookup failed — leave empty. The history entry will
        // drop the field rather than carry a noisy fallback.
      }
    }

    // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04) /
    // PEAKOPS_REPORT_LINEAGE_V1_1 (2026-05-04)
    // Append-only history. Read existing entries off packetMeta,
    // tack on the new one, and write the full array back. Worst-case
    // race (two simultaneous regenerates) drops one history entry —
    // acceptable trade-off for v1; transactional read-modify-write
    // would close the gap.
    //
    // Each entry carries a server-derived `trigger`:
    //   "generate"  → first export of this incident (revision 1)
    //   "regenerate" → any subsequent export (revision 2+)
    // For revision 1, `reason` defaults to "Initial generation" when
    // the caller didn't supply one (the regenerate textarea is the
    // only path that ever sends a reason today). For revision 2+,
    // reason is included only when non-empty — keeps the entry
    // tight when the operator skipped the textarea.
    const _existingHistory = Array.isArray(incident?.packetMeta?.history)
      ? incident.packetMeta.history.slice()
      : [];
    const _reasonText = String(body.reason || "").trim();
    const _isFirstExport = _existingRevision === 0;
    const _trigger = _isFirstExport ? "generate" : "regenerate";
    const _historyEntry = {
      revision: reportRevision,
      generatedAt: new Date().toISOString(),
      trigger: _trigger,
    };
    if (_generatedByLabel) _historyEntry.generatedBy = _generatedByLabel;
    if (_isFirstExport) {
      _historyEntry.reason = _reasonText || "Initial generation";
    } else if (_reasonText) {
      _historyEntry.reason = _reasonText;
    }
    const reportHistory = _existingHistory.concat([_historyEntry]);

    // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
    // Build an archived-vendor lookup. Any vendor whose CURRENT
    // status is "archived" (or legacy "inactive") goes in the set.
    // We use this for the audit doc's archived suffix and for the
    // tasks.json `vendor.archived` boolean — historical accuracy of
    // the *name* still uses the assignment-time snapshot on the
    // job doc.
    const archivedVendorIds = new Set();
    for (const d of vendorsSnap.docs) {
      const data = d.data() || {};
      if (data.status === "archived" || data.status === "inactive") {
        archivedVendorIds.add(d.id);
      }
    }
    function isVendorArchived(vendorId) {
      const id = String(vendorId || "").trim();
      return !!id && archivedVendorIds.has(id);
    }
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Sort by id for deterministic order across re-exports.
    const evidence = evSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const timeline = tlSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const approvedJobs = jobs.filter((j) => isApprovedJob(j));
    const evidenceByJob = evidence.reduce((acc, ev) => {
      const key = getEvidenceJobId(ev) || "unassigned";
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    const timelineNormalized = timeline.map((t) => ({ ...t, type: normalizeTimelineType(t?.type) }));


    const timelineCounts = timelineNormalized.reduce((acc, ev) => {
      const t = normalizeTimelineType(ev?.type);
      if (!t) return acc;
      acc[t] = Number(acc[t] || 0) + 1;
      return acc;
    }, {});

    const truthMismatchReasons = [];

    const unassigned = evidence.filter((ev) => !getEvidenceJobId(ev));
    if (unassigned.length > 0) {
      truthMismatchReasons.push(`${unassigned.length} evidence items unassigned`);
    }
    if ((timelineCounts["field_submitted"] || 0) < 1) {
      truthMismatchReasons.push("missing field_submitted");
    }
    if ((timelineCounts["incident_closed"] || 0) < 1) {
      truthMismatchReasons.push("missing incident_closed");
    }
    if ((timelineCounts["job_approved"] || 0) < approvedJobs.length) {
      truthMismatchReasons.push("missing job_approved events");
    }

    if (truthMismatchReasons.length > 0 && !isEmu()) {
      return j(res, 409, {
        ok: false,
        error: "truth_mismatch",
        reasons: truthMismatchReasons,
      });
    }

    const bucketObj = getStorage().bucket();
    const bucket = bucketObj.name;

    // PEAKOPS_EXPORT_AUDIT_READY_V1 (2026-04-30)
    // Customer / auditor-ready package layout:
    //
    //   <title>_<MMMdd>.zip
    //   ├── REPORT_SUMMARY.html      ← printable cover document
    //   ├── notes.txt                ← field note or skip-note affirmation
    //   ├── approvals.json           ← supervisor decisions (signoff record)
    //   ├── tasks.json               ← humanized task list
    //   ├── timeline_events.json     ← humanized event log
    //   ├── manifest.json            ← customer-facing summary
    //   └── evidence/
    //       └── <task-title-slug>/
    //           ├── 01__photo.jpg
    //           └── …
    //
    // Engineering chrome (raw bucket / storagePath / packetHash /
    // zipSha256 / per-doc internal IDs) is NOT in any customer-facing
    // file. Those fields stay on `incident.packetMeta` server-side
    // for audit hash continuity but never enter the ZIP.

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `peakops_packet_${incidentId}_`));
    // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45)
    // The operational record's sealed contents move into
    // original-record/.
    // PR 99 — Physical layout migration. Photo bytes now live in
    // required-proof/{slot-folder}/{NN}__{stem}.{ext} (declared
    // snapshot slots — always emitted, even if empty) and
    // unassigned/{NN}__{stem}.{ext} (only emitted when at least
    // one evidence doc lacks a matching requirementKey). The
    // legacy evidence/{task-slug}/ layout is REMOVED — bytes live
    // exactly once under their required-proof slot. The cover/audit
    // HTMLs in REPORTS/ render image src paths into the new
    // locations (../original-record/required-proof/{slot}/ or
    // ../original-record/unassigned/{file}). formatVersion bumps
    // 3 → 4 to signal the byte-layout change.
    const originalRecordDir = path.join(workDir, "original-record");
    await fs.promises.mkdir(originalRecordDir, { recursive: true });
    const requiredProofDir = path.join(originalRecordDir, "required-proof");
    const unassignedDir = path.join(originalRecordDir, "unassigned");

    // Read field-note + bypass state for the cover doc + notes.txt.
    const notesBlock = await loadNotes(db, incidentId);

    // Resolve a customer-facing incident title using the same chain
    // listIncidentsV1 uses on the dashboard.
    const resolvedTitle = deriveIncidentTitle(incident, jobs);

    // PEAKOPS_REPORT_LABELS_V1 (2026-05-01)
    // Resolve every approval / rejection actor UID to a display
    // label up front. After this point, no code path in the export
    // is allowed to reference j.approvedBy / j.rejectedBy directly —
    // it MUST go through labelFor() so the ZIP and the cover doc
    // never carry a raw UID. assignedTo also flows through this so
    // task assignment lines stay human-readable.
    const actorUids = new Set();
    for (const j of jobs) {
      if (j?.approvedBy) actorUids.add(String(j.approvedBy));
      if (j?.rejectedBy) actorUids.add(String(j.rejectedBy));
      if (j?.assignedTo) actorUids.add(String(j.assignedTo));
    }
    const actorLabels = await resolveActorLabels(actorUids);
    function labelFor(uid) {
      const u = String(uid || "").trim();
      if (!u) return "";
      return actorLabels.get(u) || "Authorized reviewer";
    }

    // Build customer-facing tasks.json (no raw chrome).
    const tasksOut = jobs.map((j) => {
      const out = {
        title: String(j.title || "Untitled task").trim(),
        decision: humanizeJobDecision(j),
      };
      if (j.assignedTo) out.assignedTo = labelFor(j.assignedTo);
      if (j.completedAt) out.completedAt = (j.completedAt?.toDate?.().toISOString?.() || j.completedAt);
      if (j.approvedAt) out.approvedAt = (j.approvedAt?.toDate?.().toISOString?.() || j.approvedAt);
      if (j.approvedBy) out.approvedBy = labelFor(j.approvedBy);
      if (j.rejectedAt) out.rejectedAt = (j.rejectedAt?.toDate?.().toISOString?.() || j.rejectedAt);
      if (j.rejectedBy) out.rejectedBy = labelFor(j.rejectedBy);
      if (j.rejectedReason) out.rejectedReason = String(j.rejectedReason);
      if (j.notes) out.notes = String(j.notes);
      if (j.locked) out.locked = true;
      // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
      // Vendor block. Only emitted when an assignment exists. The
      // `name` is the assignment-time snapshot stored on the job
      // doc — never re-resolved from the current vendor catalog,
      // so renames after assignment don't rewrite history. The
      // `archived` flag IS resolved live so a downstream consumer
      // can see whether the vendor is still selectable today.
      const vId = String(j.vendorId || "").trim();
      const vName = String(j.vendorName || "").trim();
      if (vId || vName) {
        out.vendor = {
          id: vId,
          name: vName,
          archived: isVendorArchived(vId),
        };
      }
      return out;
    });

    // approvals.json — terminal-state decisions only. The
    // chain-of-custody record an auditor reads first.
    const approvalsOut = jobs
      .filter((j) => {
        const rs = String(j?.reviewStatus || "").trim().toLowerCase();
        const st = String(j?.status || "").trim().toLowerCase();
        return rs === "approved" || rs === "rejected" || rs === "revision_requested" ||
          st === "approved" || st === "rejected";
      })
      .map((j) => {
        const out = {
          taskTitle: String(j.title || "Untitled task").trim(),
          decision: humanizeJobDecision(j),
          locked: !!j.locked,
        };
        const isApproved = humanizeJobDecision(j) === "Approved";
        const who = isApproved ? j.approvedBy : (j.rejectedBy || j.approvedBy);
        const when = isApproved ? j.approvedAt : (j.rejectedAt || j.approvedAt);
        if (who) out.approvedBy = labelFor(who);
        const whenIso = when?.toDate?.().toISOString?.() || when;
        if (whenIso) out.approvedAt = whenIso;
        const reason = j.rejectedReason || j.notes;
        if (reason) out.notes = String(reason);
        return out;
      });

    // timeline_events.json — humanized for customer/auditor reading.
    // `rawType` is preserved so a developer who needs the original
    // event token can still find it, but the visible label is plain
    // English.
    // PEAKOPS_REPORT_DEFENSIVE_V1 (2026-05-05)
    // Timeline ISO derivation tolerates every shape the codebase has
    // ever produced: Firestore Timestamp ({ _seconds }), Admin SDK
    // Timestamp (.toDate()), epoch-ms number, ISO string, or null.
    // Anything that fails to parse cleanly resolves to null and is
    // sorted to the bottom — never crashes the export.
    const safeIso = (occurredAt) => {
      try {
        if (!occurredAt) return null;
        if (typeof occurredAt === "number" && Number.isFinite(occurredAt)) {
          return new Date(occurredAt).toISOString();
        }
        if (typeof occurredAt === "string") {
          const ms = Date.parse(occurredAt);
          return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
        }
        if (typeof occurredAt === "object") {
          const sec = Number(occurredAt._seconds);
          if (Number.isFinite(sec) && sec > 0) {
            return new Date(sec * 1000).toISOString();
          }
          if (typeof occurredAt.toDate === "function") {
            const d = occurredAt.toDate();
            if (d && typeof d.toISOString === "function") return d.toISOString();
          }
        }
      } catch (_) { /* fall through */ }
      return null;
    };
    const humanTimeline = timelineNormalized
      .map((t) => ({
        when: safeIso(t && t.occurredAt),
        label: prettyTimelineType(t && t.type),
        actor: String((t && t.actor) || "").trim() || null,
        rawType: String((t && t.type) || "").trim(),
      }))
      .sort((a, b) => {
        const aMs = a.when ? Date.parse(a.when) : 0;
        const bMs = b.when ? Date.parse(b.when) : 0;
        return aMs - bMs;
      });

    // notes.txt — plain-text field note or the skip-note affirmation.
    const notesTxt = (() => {
      const t = notesBlock.incidentNotes;
      const s = notesBlock.siteNotes;
      const bypassed = !t && !s && (notesBlock.notesStatus === "bypassed" || !!notesBlock.notesBypassReason);
      const lines = [];
      lines.push(`Field note — ${resolvedTitle}`);
      lines.push("");
      if (bypassed) {
        lines.push("No additional note provided. Photos were submitted as sufficient documentation.");
      } else {
        if (t) {
          lines.push("Incident notes:");
          lines.push(t);
        }
        if (s) {
          if (t) lines.push("");
          lines.push("Site notes:");
          lines.push(s);
        }
        if (!t && !s) lines.push("No field note recorded.");
      }
      return lines.join("\n") + "\n";
    })();
    // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45)
    // The sealed operational record's files live under original-record/.
    // Customer/audit HTMLs at workDir/REPORTS/ reach them via
    // ../original-record/{file}.
    await fs.promises.writeFile(path.join(originalRecordDir, "notes.txt"), notesTxt, "utf8");

    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // original-record/ writes use stable serialization (sorted keys)
    // so the resulting hash is byte-identical across re-exports.
    await writeStableJson(path.join(originalRecordDir, "tasks.json"), tasksOut);
    await writeStableJson(path.join(originalRecordDir, "approvals.json"), approvalsOut);
    await writeStableJson(path.join(originalRecordDir, "timeline_events.json"), humanTimeline);

    // PR 99 — Physical Layout Migration.
    //
    // Photo bytes are routed by requirementKey to either:
    //   required-proof/{NN}__{slot-slug}/{NN}__{stem}.{ext}
    //     - one folder per declared snapshot slot (always emitted,
    //       even when empty — missing required proof stays visible
    //       on the filesystem too, not just in the manifest)
    //     - per-slot file index (resets to 01 in each folder)
    //   unassigned/{NN}__{stem}.{ext}
    //     - only emitted when at least one evidence doc lacks a
    //       matching requirementKey
    //
    // Task linkage stays in the manifest (each file entry carries
    // jobId + taskTitle) so the audit chain isn't lost — but the
    // task is no longer the byte-grouping axis. Photos that the
    // operator captured but never bound to a required slot land in
    // unassigned/ regardless of which job they belong to.
    //
    // Pre-PR-89a incidents with no snapshot: declaredSlots is [];
    // ALL evidence lands in unassigned/. README acknowledges this.

    // Build declaredSlots BEFORE the write loop so we can route by
    // slot during the loop itself.
    const reqSnapshot =
      incident && incident.requirements && typeof incident.requirements === "object"
        ? incident.requirements
        : null;
    const reqLabels = (reqSnapshot && Array.isArray(reqSnapshot.requiredProof))
      ? reqSnapshot.requiredProof.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
      : [];
    const reqSource = String(reqSnapshot?.source || "").trim() || null;
    const reqTemplateKey = String(reqSnapshot?.templateKey || "").trim() || null;
    const reqTemplateVersion =
      typeof reqSnapshot?.templateVersion === "number" ? reqSnapshot.templateVersion : null;

    const _slugSeen = new Map();
    const declaredSlots = reqLabels.map((label, index) => {
      let slug = slugRequirement(label);
      if (!slug) slug = `slot-${index + 1}`;
      const seenCount = _slugSeen.get(slug) || 0;
      _slugSeen.set(slug, seenCount + 1);
      const folderSlug = seenCount === 0 ? slug : `${slug}__${index + 1}`;
      const folderName = `${String(index + 1).padStart(2, "0")}__${folderSlug}`;
      return {
        index,
        label,
        slug,                // canonical (matches client requirementKey)
        folderSlug,          // disambiguated for cross-collision uniqueness
        folderName,          // {NN}__{folderSlug} — physical directory name
        directoryInPacket: `original-record/required-proof/${folderName}`,
        source: reqSource || "archetype",
        files: [],           // populated by the write loop below
      };
    });
    const slotByCanonicalSlug = new Map();
    for (const s of declaredSlots) {
      if (!slotByCanonicalSlug.has(s.slug)) slotByCanonicalSlug.set(s.slug, s);
    }

    // Resolve task context for each evidence doc — kept for manifest
    // traceability (each file entry carries its source jobId +
    // taskTitle) even though bytes no longer group by task.
    const taskTitleById = new Map();
    for (const j of jobs) {
      const id = String(j?.id || j?.jobId || "").trim();
      if (id) taskTitleById.set(id, String(j?.title || "").trim() || `Task ${id.slice(-6)}`);
    }

    const downloaded = [];
    const skipped = [];
    const unassignedFiles = [];

    // Per-folder file counters so each slot folder + unassigned folder
    // numbers its own files starting at 01__. Determinism preserved:
    // evidence array is already sorted by doc.id (line ~1366) so
    // assignment order is stable across re-exports.
    const slotFileCounters = new Map(); // canonical slug → next index
    let unassignedCounter = 0;
    if (declaredSlots.length > 0) {
      await fs.promises.mkdir(requiredProofDir, { recursive: true });
    }

    async function writeEvidenceToFolder(ev, targetSlot /* null = unassigned */) {
      const f = ev.file || {};
      const b = String(f.bucket || ev.bucket || bucket).trim();
      const sp = String(f.storagePath || ev.storagePath || "").trim();
      const orig = String(f.originalName || f.fileName || "").trim();
      const label = String(ev.label || (Array.isArray(ev.labels) ? ev.labels[0] : "") || "").trim();
      const linkedJobId = getEvidenceJobId(ev);
      const taskTitle = linkedJobId
        ? (taskTitleById.get(linkedJobId) || `Task ${linkedJobId.slice(-6)}`)
        : "Unassigned";

      const groupKey = targetSlot ? `slot:${targetSlot.slug}` : "unassigned";
      const idx = targetSlot
        ? ((slotFileCounters.get(targetSlot.slug) || 0) + 1)
        : (unassignedCounter + 1);
      if (targetSlot) slotFileCounters.set(targetSlot.slug, idx);
      else unassignedCounter = idx;

      const stem = (label || orig || `photo_${idx}`).replace(/[^\w.\-]+/g, "_").slice(0, 80);
      const ext = (orig.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0] || "";
      const outName = `${String(idx).padStart(2, "0")}__${stem}${ext}`;

      if (!sp) {
        skipped.push({
          name: orig || label || "(unknown)",
          group: groupKey,
          task: taskTitle,
          label,
          index: idx,
          reason: "missing_storage_path",
          evidenceId: ev.id,
          requirementKey: targetSlot ? targetSlot.slug : null,
        });
        return;
      }

      // Lazy-create the folder only when we actually have a file to
      // write into it. (Empty slot folders get created later in the
      // empty-slot pass — keeps the write path narrow.)
      const targetDir = targetSlot
        ? path.join(requiredProofDir, targetSlot.folderName)
        : unassignedDir;
      await fs.promises.mkdir(targetDir, { recursive: true });

      try {
        const buf = await fetchEvidenceBytes(b, sp);
        await fs.promises.writeFile(path.join(targetDir, outName), buf);
        const contentType = String(f.contentType || ev.contentType || "application/octet-stream");
        const fileEntry = {
          evidenceId: ev.id,
          filenameInPacket: outName,
          // Path relative to the packet root — used by manifest and
          // by the cover/audit HTMLs (via ../ when rendered from
          // REPORTS/).
          pathInPacket: targetSlot
            ? `original-record/required-proof/${targetSlot.folderName}/${outName}`
            : `original-record/unassigned/${outName}`,
          contentType,
          sizeBytes: buf.length,
          // Audit traceability — record which job the operator
          // attached the photo to AT capture time, even though the
          // file no longer lives under that task's folder.
          sourceJobId: linkedJobId || null,
          sourceTaskTitle: taskTitle,
          operatorLabel: label || null,
        };
        if (targetSlot) targetSlot.files.push(fileEntry);
        else unassignedFiles.push(fileEntry);
        downloaded.push({
          name: outName,
          label,
          index: idx,
          task: taskTitle,
          group: groupKey,
          evidenceId: ev.id,
          requirementKey: targetSlot ? targetSlot.slug : null,
        });
      } catch (e) {
        skipped.push({
          name: outName,
          group: groupKey,
          task: taskTitle,
          label,
          index: idx,
          reason: String(e?.message || e),
          evidenceId: ev.id,
          requirementKey: targetSlot ? targetSlot.slug : null,
        });
      }
    }

    // Drive each evidence doc through the router. A doc's
    // requirementKey is trusted only when it matches a declared
    // snapshot slug — stale / tampered / unknown keys (and docs with
    // no key at all) land in unassigned/. Slot tags are operator
    // intent, not enforcement.
    for (const ev of evidence) {
      const key = String(ev?.requirementKey || "").trim();
      const target = key && /^[a-z0-9-]{1,120}$/.test(key)
        ? slotByCanonicalSlug.get(key)
        : null;
      await writeEvidenceToFolder(ev, target || null);
    }

    // Emit empty required-proof slot folders + their _slot.json. A
    // satisfied slot's folder was already created during the write
    // loop above; an unsatisfied slot still needs its folder so the
    // "missing required proof" state is visible at the filesystem
    // level (not only in the manifest).
    for (const slot of declaredSlots) {
      const slotDir = path.join(requiredProofDir, slot.folderName);
      await fs.promises.mkdir(slotDir, { recursive: true });
      const slotJson = {
        requirementKey: slot.slug,
        requirementLabel: slot.label,
        requirementIndex: slot.index,
        source: slot.source,
        satisfied: slot.files.length > 0,
        evidenceCount: slot.files.length,
        attachedFiles: slot.files,
      };
      await writeStableJson(path.join(slotDir, "_slot.json"), slotJson);
    }

    // Build the manifest block — same shape as PR 98a but with
    // pathInPacket strings now pointing at the new physical layout.
    const slotManifestEntries = declaredSlots.map((s) => ({
      key: s.slug,
      label: s.label,
      index: s.index,
      source: s.source,
      satisfied: s.files.length > 0,
      evidenceCount: s.files.length,
      directoryInPacket: s.directoryInPacket,
      attachedFiles: s.files,
    }));

    const requiredProofBlock = {
      source: reqSource,
      templateKey: reqTemplateKey,
      templateVersion: reqTemplateVersion,
      totalCount: declaredSlots.length,
      satisfiedCount: slotManifestEntries.filter((s) => s.satisfied).length,
      missingCount: slotManifestEntries.filter((s) => !s.satisfied).length,
      slots: slotManifestEntries,
      unassignedEvidenceCount: unassignedFiles.length,
      unassignedDirectoryInPacket: unassignedFiles.length > 0
        ? "original-record/unassigned"
        : null,
      unassignedFiles,
      snapshotPresent: reqLabels.length > 0,
    };

    // PR 103a — Acceptance Readiness. Deterministic projection of
    // the same inputs we just read (incident + evidence + jobs).
    // Embedded in the packet manifest + README + audit HTML; also
    // surfaced on the customer doc ONLY when state is
    // "ready_for_submission" (per approved scope — customer-facing
    // never surfaces a missing-items checklist).
    const acceptanceReadiness = computeAcceptanceReadiness({
      incident,
      evidence,
      jobs,
    });

    // PR 99 — Cover-doc data structures.
    //
    // tasksWithEvidence: kept for the TASKS section, but its `photos`
    // array no longer carries image paths — just lightweight summary
    // entries so the per-task "X of Y photos bundled" line still
    // works. The EVIDENCE section reads from slotsWithPhotos
    // instead, which groups photos by required-proof slot to match
    // the new on-disk layout.
    //
    // slotsWithPhotos: one entry per declared required-proof slot
    // (always emitted, even when empty) plus a synthetic
    // "unassigned" entry when applicable. Each carries the photo
    // array with relPath pointers into the new physical location
    // (../original-record/required-proof/{folder}/ or
    // ../original-record/unassigned/{file}).

    // Per-job photo COUNTS only — no paths.
    const photoCountsByJobId = new Map();
    const photoBundledByJobId = new Map();
    const photoSkippedByJobId = new Map();
    for (const d of downloaded) {
      const jid = String(d.evidenceId ? (taskTitleById.has(d.task) ? d.task : "") : "");
      // We use the resolved task title as the key into job lookup
      // below (the task title is denormalized from the job doc).
    }
    // Re-walk downloaded + skipped keyed by jobId for accurate counts.
    for (const ev of evidence) {
      const jid = getEvidenceJobId(ev) || "__unassigned_job__";
      photoCountsByJobId.set(jid, (photoCountsByJobId.get(jid) || 0) + 1);
    }
    for (const d of downloaded) {
      const jid = (() => {
        // downloaded.task is the resolved task title, not the jobId.
        // Look up jobId by reverse map: find the job whose title
        // matches d.task. This mirrors the earlier task-resolution.
        for (const [id, title] of taskTitleById.entries()) {
          if (title === d.task) return id;
        }
        return "__unassigned_job__";
      })();
      photoBundledByJobId.set(jid, (photoBundledByJobId.get(jid) || 0) + 1);
    }
    for (const s of skipped) {
      const jid = (() => {
        for (const [id, title] of taskTitleById.entries()) {
          if (title === s.task) return id;
        }
        return "__unassigned_job__";
      })();
      photoSkippedByJobId.set(jid, (photoSkippedByJobId.get(jid) || 0) + 1);
    }

    const tasksWithEvidence = jobs.map((j) => {
      const id = String(j.id || j.jobId || "").trim();
      const taskTitle = String(j.title || "").trim() || (id ? `Task ${id.slice(-6)}` : "Untitled task");
      const decision = humanizeJobDecision(j);
      const isApproved = decision === "Approved";
      const who = isApproved ? j.approvedBy : (j.rejectedBy || j.approvedBy);
      const when = isApproved ? j.approvedAt : (j.rejectedAt || j.approvedAt);
      const whenIso = when?.toDate?.().toISOString?.() || when || null;
      const totalCount = photoCountsByJobId.get(id) || 0;
      const bundledCount = photoBundledByJobId.get(id) || 0;
      // Build a placeholder photos array sized to totalCount so the
      // existing TASKS-section counters in buildAuditHtml continue
      // to work without refactoring. Each entry has `bundled: true`
      // for successful uploads and `unavailable: true` for skipped.
      const photos = [];
      for (let i = 0; i < bundledCount; i++) photos.push({ bundled: true });
      const skippedCount = photoSkippedByJobId.get(id) || 0;
      for (let i = 0; i < skippedCount; i++) photos.push({ unavailable: true });
      return {
        title: taskTitle,
        decision,
        // PEAKOPS_REPORT_LABELS_V1 (2026-05-01)
        // Display label only — never the raw UID. Cover doc renders
        // this verbatim into the per-task meta line.
        approvedBy: who ? labelFor(who) : "",
        approvedAt: whenIso,
        locked: !!j.locked,
        notes: String(j.rejectedReason || j.notes || "").trim(),
        // PR 99 — count-only photo summary. The TASKS section
        // reads photos.length and photos.filter(p => p.bundled
        // && !p.unavailable).length to render "X of Y photos
        // bundled — see Evidence." Paths now live exclusively in
        // slotsWithPhotos below.
        photos,
        photoCount: totalCount,
        bundledCount,
        // PEAKOPS_VENDOR_ASSIGNMENT_V1 (2026-05-04)
        // Vendor name is denormalized onto the job doc at assignment
        // time, so the report carries the value the operator saw —
        // even if the vendor is later renamed or archived. We don't
        // re-resolve from orgs/{orgId}/vendors here on purpose:
        // historical accuracy beats current accuracy in an audit
        // artifact. The `vendorArchived` flag IS resolved live (off
        // archivedVendorIds) so the audit doc can flag stale
        // assignments without rewriting the captured name.
        vendorName: String(j.vendorName || "").trim(),
        vendorArchived: isVendorArchived(j.vendorId),
      };
    });

    // PR 99 — slotsWithPhotos drives the EVIDENCE section in the
    // cover doc. One entry per declared required-proof slot (always
    // emitted, even when empty), plus a synthetic "unassigned" entry
    // when at least one evidence doc lacks a matching requirementKey.
    // Each photo carries a relPath into the new physical location.
    // REPORTS/REPORT_SUMMARY.html sits one level deep at workDir/REPORTS/
    // so paths into original-record/ resolve via "../original-record/...".
    const slotsWithPhotos = [];
    // Track the per-job index ordering so we can attach a stable
    // "Photo N" caption. For each evidence doc, position within the
    // operator's own capture session — we re-derive from the
    // evidence array ordering since the per-task counter no longer
    // applies after the layout flip.
    const evPositionById = new Map();
    {
      const counters = new Map(); // jobId → next position
      for (const ev of evidence) {
        const jid = getEvidenceJobId(ev) || "__unassigned_job__";
        const p = (counters.get(jid) || 0) + 1;
        counters.set(jid, p);
        evPositionById.set(ev.id, p);
      }
    }
    for (const slot of declaredSlots) {
      const photoEntries = [];
      // Successful files (sorted by per-slot file index for stable
      // display).
      for (const f of slot.files) {
        const ev = evidence.find((e) => e.id === f.evidenceId);
        photoEntries.push({
          name: f.filenameInPacket,
          label: ev?.label || (Array.isArray(ev?.labels) ? ev.labels[0] : "") || "",
          index: evPositionById.get(f.evidenceId) || 0,
          relPath: `../${f.pathInPacket}`,
          taskTitle: f.sourceTaskTitle || "",
        });
      }
      // Skipped files that targeted this slot — render as
      // "Image unavailable" tile so missing-but-attempted proof
      // stays visible.
      for (const s of skipped) {
        if (s.requirementKey !== slot.slug) continue;
        photoEntries.push({
          name: String(s.name || "photo"),
          label: s.label || "",
          index: s.index,
          unavailable: true,
          taskTitle: s.task || "",
        });
      }
      photoEntries.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
      slotsWithPhotos.push({
        kind: "required",
        slug: slot.slug,
        label: slot.label,
        index: slot.index,
        source: slot.source,
        satisfied: slot.files.length > 0,
        evidenceCount: slot.files.length,
        directoryInPacket: slot.directoryInPacket,
        photos: photoEntries,
      });
    }
    if (unassignedFiles.length > 0 || skipped.some((s) => !s.requirementKey)) {
      const unassignedPhotos = [];
      for (const f of unassignedFiles) {
        const ev = evidence.find((e) => e.id === f.evidenceId);
        unassignedPhotos.push({
          name: f.filenameInPacket,
          label: ev?.label || (Array.isArray(ev?.labels) ? ev.labels[0] : "") || "",
          index: evPositionById.get(f.evidenceId) || 0,
          relPath: `../${f.pathInPacket}`,
          taskTitle: f.sourceTaskTitle || "",
        });
      }
      for (const s of skipped) {
        if (s.requirementKey) continue;
        unassignedPhotos.push({
          name: String(s.name || "photo"),
          label: s.label || "",
          index: s.index,
          unavailable: true,
          taskTitle: s.task || "",
        });
      }
      unassignedPhotos.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
      slotsWithPhotos.push({
        kind: "unassigned",
        slug: "unassigned",
        label: "General / Unassigned proof",
        index: declaredSlots.length,
        source: null,
        satisfied: unassignedPhotos.length > 0,
        evidenceCount: unassignedFiles.length,
        directoryInPacket: "original-record/unassigned",
        photos: unassignedPhotos,
      });
    }

    // Build the cover document with all the resolved values.
    const incidentStatus = String(incident.status || "").trim() || "—";
    const tsCreated = incident.createdAt;
    const tsClosed = incident.closedAt;
    // Submitted / approved derived from timeline events when not on the
    // incident doc itself (older shapes don't store them).
    const findEvent = (...types) => {
      const set = new Set(types);
      for (const t of humanTimeline) {
        if (!t || !t.rawType) continue;
        if (set.has(t.rawType)) return t.when || null;
      }
      return null;
    };
    const tsSubmitted = findEvent("field_submitted");
    // Per-incident "approved at" — pick the latest task-approval event
    // when no incident-level approvedAt exists on the doc.
    const tsApproved = (() => {
      const direct = incident.approvedAt?.toDate?.().toISOString?.() || incident.approvedAt;
      if (direct) return direct;
      let latest = 0;
      for (const t of humanTimeline) {
        if (t.rawType === "job_approved" || t.rawType === "task_approved") {
          const ms = t.when ? Date.parse(t.when) : 0;
          if (Number.isFinite(ms) && ms > latest) latest = ms;
        }
      }
      return latest > 0 ? new Date(latest).toISOString() : null;
    })();
    const tasksCompleted = jobs.filter((j) => {
      const k = humanizeJobDecision(j);
      return k === "Complete" || k === "Approved" || k === "In review";
    }).length;

    // PEAKOPS_REPORT_DISPLAY_TITLE_V1 (2026-05-01)
    // Single source of truth for the H1 / <title> shown to humans in
    // BOTH the audit and customer reports. Computed once here, passed
    // to both render functions. Any drift between audit and customer
    // titles is now structurally impossible — both consume the same
    // variable.
    //
    // Resolution priority (matches the spec):
    //   1. cleaner task title (when incident title is slug-shaped)
    //   2. humanized incident title (slug → "Title Case")
    //   3. raw incident title verbatim (when it's already human)
    //   4. "Untitled incident" — never reached unless deriveIncidentTitle
    //      itself returned empty
    //
    // humanizeCustomerTitle handles 1–3 in that order; deriveIncidentTitle
    // handles step 4 upstream. Helper is idempotent — passing it an
    // already-humanized string is a no-op, so the customer doc's
    // internal humanize call (kept as defense-in-depth) is harmless.
    const displayTitle = humanizeCustomerTitle(resolvedTitle, tasksWithEvidence);

    // PEAKOPS_AUDIT_TITLE_FIX_V3 (2026-05-01)
    // Definitive deploy-state probe. Pairs with the
    // `<!-- AUDIT_TITLE_FIX_V3 -->` marker emitted in the audit HTML
    // (search REPORT_SUMMARY.html source for it). If you see this
    // log line in firebase functions:log AND the marker in the
    // rendered ZIP's REPORT_SUMMARY.html, the new code is live and
    // the title shown matches `auditTitle` here. Missing line OR
    // missing marker = stale deploy.
    // eslint-disable-next-line no-console
    console.log(
      `[export audit title check] marker=AUDIT_TITLE_FIX_V3 auditTitle=${JSON.stringify(displayTitle)} rawResolved=${JSON.stringify(resolvedTitle)} taskCount=${(tasksWithEvidence || []).length}`,
    );

    // PEAKOPS_REPORT_RENDER_GUARD_V1 (2026-05-05)
    // Wrap both HTML builders in try/catch so a render-time crash
    // (any unguarded null in the template) never 500s the export.
    // On failure we log [export-packet-render] failed with the
    // builder name + stack and substitute a tiny fallback HTML so
    // the ZIP still ships and the user can download SOMETHING. The
    // top-level catch above stays as a last-resort net.
    function _fallbackHtml(kind, errMessage) {
      const safeTitle = String(displayTitle || incidentId || "Job report").replace(/[<>&]/g, "");
      const safeId = String(incidentId || "").replace(/[<>&]/g, "");
      const note = String(errMessage || "").replace(/[<>&]/g, "").slice(0, 200);
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
        `<style>body{font-family:system-ui,sans-serif;color:#222;padding:32px;max-width:760px;margin:0 auto}` +
        `h1{font-size:22px;margin:0 0 8px}.id{color:#666;font-size:11px;font-family:monospace}` +
        `.note{margin-top:24px;padding:12px 14px;border:1px solid #d4d4d8;border-radius:6px;color:#666;font-size:12px;line-height:1.6}</style>` +
        `</head><body><h1>${safeTitle}</h1><div class="id">${safeId}</div>` +
        `<div class="note">This ${kind === "audit" ? "audit" : "customer"} document could not be fully rendered. The packet contents (photos, timeline, notes) are still available in this ZIP. Re-running the export usually resolves the issue. ` +
        (note ? `<br/><br/><span style="font-family:monospace">${note}</span>` : "") +
        `</div></body></html>`;
    }
    let coverHtml;
    try {
      coverHtml = buildCoverHtml({
      // PEAKOPS_REPORT_DISPLAY_TITLE_V1 (2026-05-01)
      // displayTitle is the SAME string used by the customer doc
      // call below. Drift between the two is structurally
      // impossible from this point.
      title: displayTitle,
      incidentId,
      orgId,
      // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
      orgName: _packetOrgName,
      incidentStatus,
      timestamps: {
        created: tsCreated,
        submitted: tsSubmitted,
        approved: tsApproved,
        closed: tsClosed,
      },
      counts: {
        tasksTotal: jobs.length,
        tasksApproved: approvedJobs.length,
        tasksCompleted,
        evidence: downloaded.length,
      },
      location: String(incident.location || incident.site || "").trim(),
      priority: String(incident.priority || "").trim(),
      notesBlock,
      tasksWithEvidence,
      // PR 99 — required-proof slot grouping for the EVIDENCE section.
      slotsWithPhotos,
      // PR 103a — Acceptance Readiness projection for the new
      // Acceptance Readiness audit-doc section. Audit doc always
      // shows the checklist (✓/✗ per check); customer doc only
      // surfaces a positive line when state is ready (see below).
      acceptanceReadiness,
      // PR 104 — Customer Acceptance Criteria prose (from the
      // snapshot). Rendered as informational block in the audit
      // doc only — customer doc never echoes the customer's own
      // criteria back to them.
      acceptanceCriteria: Array.isArray(incident?.requirements?.acceptanceCriteria)
        ? incident.requirements.acceptanceCriteria
        : null,
      humanTimeline,
      generatedAt: new Date().toISOString(),
      // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
      reportRevision,
      });
    } catch (renderErr) {
      // eslint-disable-next-line no-console
      console.error("[export-packet-render] failed", {
        builder: "audit",
        incidentId,
        message: String(renderErr?.message || renderErr),
        stack: renderErr?.stack ? String(renderErr.stack).split("\n").slice(0, 6).join(" | ") : null,
      });
      coverHtml = _fallbackHtml("audit", String(renderErr?.message || renderErr));
    }

    // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
    // Two HTMLs in REPORTS/, both reading the same evidence/ tree
    // via relative paths (../evidence/<slug>/<file>):
    //   - REPORT_SUMMARY.html   → audit-grade, full hierarchy
    //   - CUSTOMER_SUMMARY.html → friendlier, customer-facing
    let customerHtml;
    try {
      customerHtml = buildCustomerHtml({
      // PEAKOPS_REPORT_DISPLAY_TITLE_V1 (2026-05-01)
      // Pass the already-humanized displayTitle (same one the audit
      // doc uses). buildCustomerHtml's internal humanizeCustomerTitle
      // is idempotent — re-applying it to an already-humanized string
      // is a no-op — but the customer doc no longer depends on that
      // call to clean up the title; it's clean before it arrives.
      title: displayTitle,
      incidentId,
      // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
      orgName: _packetOrgName,
      timestamps: {
        created: tsCreated,
        submitted: tsSubmitted,
        approved: tsApproved,
        closed: tsClosed,
      },
      location: String(incident.location || incident.site || "").trim(),
      notesBlock,
      tasksWithEvidence,
      // PR 99 — required-proof slot grouping for the customer Photos section.
      slotsWithPhotos,
      // PR 103a — Acceptance Readiness, surfaced ONLY when state is
      // "ready_for_submission" (per approved scope: customer-facing
      // doc never displays a missing-items checklist).
      acceptanceReadiness,
      generatedAt: new Date().toISOString(),
      // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
      reportRevision,
      });
    } catch (renderErr) {
      // eslint-disable-next-line no-console
      console.error("[export-packet-render] failed", {
        builder: "customer",
        incidentId,
        message: String(renderErr?.message || renderErr),
        stack: renderErr?.stack ? String(renderErr.stack).split("\n").slice(0, 6).join(" | ") : null,
      });
      customerHtml = _fallbackHtml("customer", String(renderErr?.message || renderErr));
    }

    // PEAKOPS_REPORT_ENGINE_V1 (2026-04-30)
    // Cover document lives under REPORTS/ so it reads as the primary
    // deliverable. Relative paths from REPORTS/REPORT_SUMMARY.html to
    // the evidence/ siblings stay valid (../evidence/<slug>/<file>).
    const reportsDir = path.join(workDir, "REPORTS");
    await fs.promises.mkdir(reportsDir, { recursive: true });
    // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
    // Pre-write intent log so the function-logs viewer can confirm
    // the new code is actually executing. If you redeploy and DON'T
    // see this line in firebase functions:log, the deploy didn't
    // take effect.
    // eslint-disable-next-line no-console
    console.log("[export] writing reports:", ["REPORT_SUMMARY", "CUSTOMER_SUMMARY"]);

    const auditFilePath = path.join(reportsDir, "REPORT_SUMMARY.html");
    const customerFilePath = path.join(reportsDir, "CUSTOMER_SUMMARY.html");
    await fs.promises.writeFile(auditFilePath, coverHtml, "utf8");
    await fs.promises.writeFile(customerFilePath, customerHtml, "utf8");

    // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
    // Post-write verification. Reads back the directory listing +
    // sizes from disk so we know definitively (a) both files exist,
    // (b) neither is 0 bytes, (c) we're looking at fresh-code
    // output. Hard-fail with a customer_summary_missing_* error if
    // anything is off — never ship a partial ZIP silently.
    const reportsListing = await fs.promises.readdir(reportsDir);
    const sizes = {};
    for (const f of reportsListing) {
      try {
        const st = await fs.promises.stat(path.join(reportsDir, f));
        sizes[f] = st.size;
      } catch { sizes[f] = -1; }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[exportIncidentPacketV1] wrote reports:`,
      reportsListing.sort().map((f) => `${f}(${sizes[f]}b)`).join(", "),
    );
    if (!reportsListing.includes("CUSTOMER_SUMMARY.html")) {
      throw new Error(
        `customer_summary_missing_after_write: REPORTS/ contains [${reportsListing.join(", ")}]`,
      );
    }
    if ((sizes["CUSTOMER_SUMMARY.html"] || 0) <= 0) {
      throw new Error(
        `customer_summary_zero_bytes: REPORTS/CUSTOMER_SUMMARY.html size=${sizes["CUSTOMER_SUMMARY.html"]}`,
      );
    }

    // PEAKOPS_REPORT_ENGINE_V1 (2026-04-30)
    // Forward-compatible manifest declaring the report shape baked
    // into this ZIP plus the formats this engine version is prepared
    // to render. The handler does not switch on `?report=` yet — this
    // is purely a contract surface so future query-param routing
    // doesn't need a data-shape migration.
    //
    // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
    // Trimmed to the formats actually shipped in this ZIP:
    // internal_audit (REPORT_SUMMARY.html) + customer_summary
    // (CUSTOMER_SUMMARY.html). Removed forward-looking
    // fema_support / insurance_support entries — easier to add
    // back when those variants ship than to live with a
    // contract that overstates capabilities.
    // PEAKOPS_VENDOR_ASSIGNMENT_V1_1 (2026-05-04)
    // schemaVersion 2 adds the per-task `vendor: { id, name,
    // archived }` block in tasks.json. Older readers that don't know
    // about the field will simply ignore it; the rest of the
    // schema is unchanged.
    // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
    // reportRevision tracks how many times this incident has been
    // exported. 1 on first export, increments per regenerate. Useful
    // for "I'm reading revision 3 — is there a revision 4 yet?"
    // questions on shared bundles.
    await writeJson(path.join(workDir, "report_manifest.json"), {
      reportType: "internal_audit",
      availableFormats: [
        "internal_audit",
        "customer_summary",
      ],
      schemaVersion: 2,
      reportRevision,
      // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
      // Cumulative history. Each entry is the snapshot of one
      // export — revision number, ISO timestamp, optional
      // generatedBy label, optional reason. No UIDs, no internal
      // field names. Auditors can scan the array to see who
      // regenerated and why.
      history: reportHistory,
      generatedAt: new Date().toISOString(),
    });

    // Customer-facing operational manifest. No raw bucket/storagePath/
    // zip-hash etc. — those live on incident.packetMeta server-side
    // for audit-hash continuity but never enter the ZIP.
    //
    // PEAKOPS_REPORT_IMG_BUNDLED_V1 (2026-05-01)
    // `reportImagePath` is a debug-only contract field declaring the
    // path shape REPORT_SUMMARY.html uses for evidence images. It
    // confirms the report body uses bundled relative paths (no API
    // route, no signed URL, no storage internals) without exposing
    // any actual bucket/path string. The HTML body never references
    // this value — it's only readable by anyone inspecting the ZIP's
    // manifest.
    // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45)
    // The operational-record manifest moves under original-record/.
    // Its reportImagePath now reflects the new evidence location.
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // generatedAt is FROZEN to incident closure time so re-exports
    // produce identical manifest bytes. reportRevision is removed
    // from this manifest (per-export state belongs in packet-
    // manifest.json, not in the sealed original record). Both
    // changes are required for originalRecordHash byte-stability.
    const _closedAtIso = (() => {
      try {
        if (!incident || !incident.closedAt) return null;
        if (typeof incident.closedAt === "string") return incident.closedAt;
        if (typeof incident.closedAt.toDate === "function") {
          return incident.closedAt.toDate().toISOString();
        }
        if (incident.closedAt._seconds) {
          return new Date(Number(incident.closedAt._seconds) * 1000).toISOString();
        }
      } catch (_) { /* fall through */ }
      return null;
    })();
    await writeStableJson(path.join(originalRecordDir, "manifest.json"), {
      title: resolvedTitle,
      incidentId,
      orgId,
      generatedAt: _closedAtIso,
      counts: {
        tasksTotal: jobs.length,
        tasksApproved: approvedJobs.length,
        tasksCompleted,
        evidence: downloaded.length,
        evidenceSkipped: skipped.length,
        timelineEvents: humanTimeline.length,
      },
      reportImagePath: "../original-record/required-proof/<NN__slot-slug>/<filename> or ../original-record/unassigned/<filename>",
      evidenceSkipped: skipped,
    });

    // PEAKOPS_SEALED_PACKET_V2_ADDENDA_V1 (2026-05-19, PR 45)
    // Fetch supplemental addenda (PR 43 collection). Failure here
    // is non-fatal — the packet still emits with an empty
    // supplemental section. Addenda are returned newest-first by
    // listAddendaV1; for export the chain reads chronologically.
    let addenda = [];
    try {
      const addSnap = await incRef
        .collection("addenda")
        .orderBy("createdAt", "asc")
        .limit(500)
        .get();
      addenda = addSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[exportIncidentPacketV1] addenda_fetch_failed", e && e.message);
      addenda = [];
    }

    // PEAKOPS_SEALED_PACKET_V2_SUPPLEMENTAL_V1 (2026-05-19, PR 45)
    // supplemental-addenda/ directory only created when at least one
    // addendum exists — incidents with no addenda emit a clean
    // two-section packet (original-record + REPORTS) with no empty
    // supplemental folder.
    const addendaEmitted = [];
    const addendaSkipped = [];
    let supplementalSectionHash = null;
    if (addenda.length > 0) {
      const supplementalDir = path.join(workDir, "supplemental-addenda");
      const addendaRootDir = path.join(supplementalDir, "addenda");
      await fs.promises.mkdir(addendaRootDir, { recursive: true });

      for (const ad of addenda) {
        const aid = String(ad.id || ad.addendumId || "").trim();
        if (!aid) continue;
        const adDir = path.join(addendaRootDir, aid);
        await fs.promises.mkdir(adDir, { recursive: true });

        // Resolve filer identity via the same actor-label resolver
        // used by the rest of the packet.
        const filerUid = String(ad.createdBy || "").trim();
        if (filerUid) actorUids.add(filerUid);
        // Note: resolveActorLabels was already invoked above with the
        // original set; for addenda filers added after that resolve,
        // we fall through to labelFor which returns "Authorized
        // reviewer" if unresolved. Acceptable interim — PR 47 / future
        // polish can re-resolve.

        let attachmentBlock = null;
        const f = (ad.file && typeof ad.file === "object") ? ad.file : null;
        if (f && f.bucket && f.storagePath) {
          const origName = String(f.originalName || "attachment").trim();
          const safeName = origName.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "attachment";
          try {
            const buf = await fetchEvidenceBytes(String(f.bucket), String(f.storagePath));
            await fs.promises.writeFile(path.join(adDir, safeName), buf);
            const fileHash = require("crypto").createHash("sha256").update(buf).digest("hex");
            attachmentBlock = {
              filenameInPacket: safeName,
              originalName: origName,
              contentType: String(f.contentType || "application/octet-stream"),
              sizeBytes: buf.length,
              sha256: fileHash,
            };
          } catch (e) {
            addendaSkipped.push({ addendumId: aid, reason: String(e && e.message) || "attachment_download_failed" });
          }
        }

        const filedAtIso = safeIso(ad.createdAt);
        const reasonRaw = String(ad.reason || "").toLowerCase();
        const reasonLabel =
          reasonRaw === "clarification" ? "Clarification" :
          reasonRaw === "customer_followup" ? "Customer follow-up" :
          reasonRaw === "audit_support" ? "Audit support" :
          reasonRaw === "other" ? "Other" :
          reasonRaw || "Addendum";

        const addendumJson = {
          addendumId: aid,
          filedAt: filedAtIso,
          filedBy: {
            uid: filerUid || null,
            label: filerUid ? labelFor(filerUid) : null,
          },
          reason: reasonRaw || null,
          reasonLabel,
          note: String(ad.note || ""),
          attachment: attachmentBlock,
          recordSealAtAddendumTime: ad.recordSealAtAddendumTime || null,
          relatedJobId: String(ad.relatedJobId || "") || null,
          disclaimer: "This addendum was filed after operational record closure and does not modify the original field record.",
        };
        await writeJson(path.join(adDir, "addendum.json"), addendumJson);
        addendaEmitted.push({
          addendumId: aid,
          filedAt: filedAtIso,
          filedBy: filerUid ? labelFor(filerUid) : null,
          reason: reasonRaw || null,
          reasonLabel,
          hasAttachment: !!attachmentBlock,
        });
      }

      await writeJson(path.join(supplementalDir, "manifest.json"), {
        title: "Supplemental addenda",
        incidentId,
        orgId,
        generatedAt: new Date().toISOString(),
        count: addendaEmitted.length,
        skipped: addendaSkipped,
        disclaimer: "Addenda are filed after operational record closure and do not modify the original record.",
        addenda: addendaEmitted,
      });

      // Placeholder hash for the supplemental section. PR 46 makes
      // both section hashes deterministic + byte-stable across
      // re-exports.
      const supplementalHashStr = require("crypto")
        .createHash("sha256")
        .update(JSON.stringify(addendaEmitted))
        .digest("hex");
      supplementalSectionHash = `sha256:${supplementalHashStr}`;
      await fs.promises.writeFile(
        path.join(supplementalDir, "supplemental-addenda-hash.txt"),
        `${supplementalSectionHash}\n`,
        "utf8"
      );
    }

    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Compute the real originalRecordHash now that all original-
    // record/ files are written and content-stable. The hash file
    // itself is excluded from the input (recursion guard). The
    // resulting hash is byte-identical across re-exports of the
    // same Firestore state.
    const _originalHashResult = await computeOriginalRecordHash(
      originalRecordDir,
      "original-record-hash.txt"
    );
    const _originalRecordHash = _originalHashResult.hash;
    await fs.promises.writeFile(
      path.join(originalRecordDir, "original-record-hash.txt"),
      _originalRecordHash + "\n",
      "utf8"
    );

    // PEAKOPS_SEALED_PACKET_V2_CHAIN_OF_CUSTODY_V1 (2026-05-19, PR 45)
    // Combined chain: every operational-record timeline event with
    // origin="operational_record", followed by every addendum filing
    // with origin="supplemental_addendum". Sorted ascending by ISO
    // timestamp; entries without a valid timestamp sort to the
    // bottom (mirrors humanTimeline's safeIso behavior above).
    const chainEntries = [
      ...humanTimeline.map((t) => ({
        when: t.when,
        kind: t.rawType || t.label,
        label: t.label,
        actor: t.actor || null,
        origin: "operational_record",
      })),
      ...addendaEmitted.map((a) => ({
        when: a.filedAt,
        kind: "ADDENDUM_FILED",
        label: `Addendum filed (${a.reasonLabel})`,
        actor: a.filedBy || null,
        origin: "supplemental_addendum",
        addendumId: a.addendumId,
        reason: a.reason,
      })),
    ].sort((x, y) => {
      const ax = x.when ? Date.parse(x.when) : Number.POSITIVE_INFINITY;
      const ay = y.when ? Date.parse(y.when) : Number.POSITIVE_INFINITY;
      return ax - ay;
    });
    await writeJson(path.join(workDir, "chain-of-custody.json"), {
      incidentId,
      orgId,
      generatedAt: new Date().toISOString(),
      operationalRecordEventCount: humanTimeline.length,
      supplementalAddendumCount: addendaEmitted.length,
      entries: chainEntries,
    });

    // PEAKOPS_SEALED_PACKET_V2_PACKET_MANIFEST_V1 (2026-05-19, PR 45)
    // Top-level audit manifest. Distinct from original-record/manifest.json
    // (operational record details) and report_manifest.json (REPORTS/
    // artifact details). This manifest is the single document that
    // describes the packet as a whole: format version, two-section
    // hashes, and history.
    // PEAKOPS_DETERMINISTIC_HASH_V1 (2026-05-19, PR 46)
    // Real originalRecordHash now (computed above). topLevelHash is
    // sha256(originalRecordHash || (supplementalAddendaHash || "")):
    // sealed-section identity stays stable across re-exports; topLevel
    // changes only when addenda accumulate.
    const _topLevelInput = _originalRecordHash + "||" + (supplementalSectionHash || "");
    const _topLevelHash = "sha256:" + require("crypto")
      .createHash("sha256")
      .update(_topLevelInput, "utf8")
      .digest("hex");

    const packetManifest = {
      schemaVersion: 1,
      // PR 99 — formatVersion bump 3 → 4 (physical layout migration).
      // PR 103a — formatVersion bump 4 → 5 (acceptanceReadiness block).
      // PR 104 — formatVersion bump 5 → 6 signals two manifest-shape
      // changes that strict consumers might notice:
      //   1. acceptanceReadiness.checks[] entries can now carry
      //      satisfied: "unknown" (string), not just true/false (bool).
      //      Comes from template-referenced check types the current
      //      backend doesn't recognize (forward-compat per §5).
      //   2. acceptanceReadiness.checks[] can include two new
      //      categories: "template_check" and "template_check_unknown".
      //   3. acceptanceReadiness.summary now has requiredUnknown and
      //      encouragedUnknown count fields.
      //   4. incident.requirements snapshot (inside the original-record/
      //      JSON dumps) can carry acceptanceChecks[] and
      //      acceptanceCriteria[] arrays. Already-emitted v5 packets
      //      stay valid; future re-exports produce v6.
      formatVersion: 6,
      incidentId,
      orgId,
      packetVersion: reportRevision,
      exportedAt: new Date().toISOString(),
      originalRecord: {
        closedAt: _closedAtIso,
        hash: _originalRecordHash,
        evidenceCount: evidence.length,
        jobCount: approvedJobs.length,
        timelineEventCount: humanTimeline.length,
      },
      supplementalAddenda: {
        count: addendaEmitted.length,
        hash: supplementalSectionHash,
        addenda: addendaEmitted,
      },
      // PR 98a — Required-proof index. See requirementsSnapshot
      // (PR 89a/91) + addEvidenceV1 slot fields (PR 94a) + the
      // grouping logic earlier in this function. Pointers into the
      // existing evidence/{task-slug}/ layout — no byte duplication.
      requiredProof: requiredProofBlock,
      // PR 103a — Acceptance Readiness projection at export time.
      // Frozen at this revision's bytes; readers can detect drift
      // by re-computing against current incident state. Same shape
      // returned by getAcceptanceReadinessV1.
      acceptanceReadiness: {
        ...acceptanceReadiness,
        packetRevisionAtComputation: reportRevision,
      },
      topLevelHash: _topLevelHash,
      history: reportHistory,
    };
    await writeJson(path.join(workDir, "packet-manifest.json"), packetManifest);

    // PEAKOPS_SEALED_PACKET_V2_README_V1 (2026-05-19, PR 45)
    // README_FIRST.txt — plain-text, intentionally NOT markdown for
    // maximum compatibility with offline / customer / auditor
    // unzipping tools.
    const readmeLines = [
      "PEAKOPS OPERATIONAL RECORD PACKET",
      "─────────────────────────────────",
      "",
      `Incident:     ${resolvedTitle}`,
      `Org:          ${orgId}`,
      `Closed:       ${packetManifest.originalRecord.closedAt || "(not recorded)"}`,
      `Exported:     ${packetManifest.exportedAt}`,
      `Packet ID:    ${incidentId}__v${reportRevision}`,
      "",
      "This packet contains two sections:",
      "",
      "  1. ORIGINAL OPERATIONAL RECORD  (original-record/)",
      "     The sealed field record as it existed at incident closure.",
      "     Re-exporting the same incident later produces an identical",
      "     original-record/ section (verifiable by hash). Original",
      "     record hash: " + _originalRecordHash,
      "",
      "  2. SUPPLEMENTAL ADDENDA  (supplemental-addenda/)",
      "     Context filed after closure, in chronological order. Each",
      "     addendum identifies the filer, the time of filing, and the",
      "     stated reason. Addenda do not modify the original record —",
      "     they exist alongside it as transparent supplemental material.",
      `     Addenda included: ${addendaEmitted.length}`,
      "     Supplemental section hash: " + (supplementalSectionHash || "(none — no addenda filed)"),
      "",
      "Customer + audit reports live under REPORTS/.",
      "Combined chain-of-custody record: chain-of-custody.json.",
      "",
    ];

    // PR 98a — Required-Proof section. Renders as a human-readable
    // checklist mirroring the requiredProof block in packet-manifest.
    // Slot order = declared snapshot order (immutable at incident
    // creation). Captured/missing status is explicit and reviewable.
    // Pre-PR-89a incidents (no snapshot) get a one-line acknowledgement.
    readmeLines.push("REQUIRED PROOF");
    readmeLines.push("──────────────");
    if (!requiredProofBlock.snapshotPresent) {
      readmeLines.push("No required-proof snapshot existed for this field record.");
      readmeLines.push("All captured proof is listed under GENERAL / UNASSIGNED PROOF below.");
    } else {
      // Source header line
      const _srcDisplay = (() => {
        if (requiredProofBlock.source === "customer_template") {
          const parts = ["Customer template"];
          if (requiredProofBlock.templateKey) parts.push(requiredProofBlock.templateKey);
          if (typeof requiredProofBlock.templateVersion === "number") {
            parts.push(`v${requiredProofBlock.templateVersion}`);
          }
          return parts.join(" — ");
        }
        if (requiredProofBlock.source === "org_template") {
          return typeof requiredProofBlock.templateVersion === "number"
            ? `Org template — v${requiredProofBlock.templateVersion}`
            : "Org template";
        }
        return "Archetype defaults";
      })();
      readmeLines.push(`Source:    ${_srcDisplay}`);
      readmeLines.push(`Satisfied: ${requiredProofBlock.satisfiedCount} / ${requiredProofBlock.totalCount}`);
      readmeLines.push("");
      for (const slot of requiredProofBlock.slots) {
        const tick = slot.satisfied ? "✓" : "✗";
        const countSuffix = slot.satisfied
          ? ` — ${slot.evidenceCount} ${slot.evidenceCount === 1 ? "file" : "files"}`
          : " — no proof captured";
        readmeLines.push(`  ${tick} ${slot.label}${countSuffix}`);
        for (const f of slot.attachedFiles) {
          readmeLines.push(`        → ${f.pathInPacket}`);
        }
      }
    }
    readmeLines.push("");
    readmeLines.push("GENERAL / UNASSIGNED PROOF");
    readmeLines.push("──────────────────────────");
    if (requiredProofBlock.unassignedEvidenceCount === 0) {
      readmeLines.push("(none — every captured proof item is bound to a required-proof slot)");
    } else {
      const n = requiredProofBlock.unassignedEvidenceCount;
      readmeLines.push(`${n} ${n === 1 ? "file" : "files"} not bound to any required-proof slot:`);
      for (const f of requiredProofBlock.unassignedFiles) {
        readmeLines.push(`  → ${f.pathInPacket}`);
      }
    }
    readmeLines.push("");
    readmeLines.push("Files referenced above live at original-record/required-proof/{slot}/");
    readmeLines.push("and (when present) original-record/unassigned/. Each slot folder also");
    readmeLines.push("contains a _slot.json descriptor with the requirement label, source,");
    readmeLines.push("satisfaction state, and attached-file list. Each evidence doc records");
    readmeLines.push("the source task it was attached to at capture time (sourceJobId +");
    readmeLines.push("sourceTaskTitle in the manifest); see original-record/tasks.json for");
    readmeLines.push("the per-task decision and approval state.");
    readmeLines.push("");

    // PR 103a — Acceptance Readiness section. Deterministic
    // projection of the same inputs that drove the required-proof
    // structure above. Three possible states:
    //   - "ready_for_submission" : every required check satisfied
    //   - "requirements_missing" : at least one required unsatisfied
    //   - "not_available"        : no snapshot AND no evidence
    //                              (legacy fallback)
    // When the state is "requirements_missing" we list the missing
    // checks explicitly so the auditor (or the operator reviewing
    // their own packet) can see exactly what is not yet satisfied.
    // The packet was exported regardless — gating is the caller's
    // call, not the readiness engine's.
    readmeLines.push("ACCEPTANCE READINESS AT EXPORT");
    readmeLines.push("──────────────────────────────");
    const _stateLabel = {
      ready_for_submission: "Ready for submission",
      requirements_missing: "Requirements missing",
      not_available: "Not available (no snapshot or evidence)",
    }[acceptanceReadiness.state] || acceptanceReadiness.state;
    readmeLines.push(`State:      ${_stateLabel}`);
    readmeLines.push(`Required:   ${acceptanceReadiness.summary.requiredSatisfied} / ${acceptanceReadiness.summary.requiredTotal} satisfied`);
    if (acceptanceReadiness.summary.encouragedTotal > 0) {
      readmeLines.push(`Encouraged: ${acceptanceReadiness.summary.encouragedSatisfied} / ${acceptanceReadiness.summary.encouragedTotal} satisfied`);
    }
    readmeLines.push("");

    // PR 104 — Explicit satisfied / missing / unknown filters.
    // Critical: "unknown" satisfaction (template_check_unknown
    // category) must NOT count as missing — those rows render in a
    // dedicated subsection. State has already been computed by the
    // engine ignoring unknowns per approved decision §5.
    const _checks = acceptanceReadiness.checks || [];
    const _requiredMissing = _checks.filter((c) => c.tier === "required" && c.satisfied === false);
    const _requiredSatisfied = _checks.filter((c) => c.tier === "required" && c.satisfied === true);
    const _encouragedMissing = _checks.filter((c) => c.tier === "encouraged" && c.satisfied === false);
    const _encouragedSatisfied = _checks.filter((c) => c.tier === "encouraged" && c.satisfied === true);
    const _unknownChecks = _checks.filter((c) => c.satisfied === "unknown");

    function _writeCheckRow(c, glyph) {
      readmeLines.push(`  ${glyph} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    }

    if (acceptanceReadiness.state === "requirements_missing") {
      readmeLines.push("Missing (required):");
      for (const c of _requiredMissing) _writeCheckRow(c, "✗");
      readmeLines.push("");
      if (_requiredSatisfied.length > 0) {
        readmeLines.push("Satisfied (required):");
        for (const c of _requiredSatisfied) _writeCheckRow(c, "✓");
        readmeLines.push("");
      }
    } else if (acceptanceReadiness.state === "ready_for_submission") {
      readmeLines.push("Satisfied (required):");
      for (const c of _requiredSatisfied) _writeCheckRow(c, "✓");
      readmeLines.push("");
    } else {
      readmeLines.push("Readiness could not be evaluated for this packet — no");
      readmeLines.push("required-proof snapshot existed and no evidence was captured.");
      readmeLines.push("Legacy / pre-snapshot incidents fall into this state.");
      readmeLines.push("");
    }

    // PR 104 — Encouraged-tier rendering (only when there are
    // encouraged checks declared — MVP universal checks don't add
    // any; template-driven checks may).
    if (_encouragedMissing.length > 0 || _encouragedSatisfied.length > 0) {
      if (_encouragedMissing.length > 0) {
        readmeLines.push("Missing (encouraged — not blocking):");
        for (const c of _encouragedMissing) _writeCheckRow(c, "✗");
        readmeLines.push("");
      }
      if (_encouragedSatisfied.length > 0) {
        readmeLines.push("Satisfied (encouraged):");
        for (const c of _encouragedSatisfied) _writeCheckRow(c, "✓");
        readmeLines.push("");
      }
    }

    // PR 104 — Unknown checks subsection (template referenced a
    // check type the current backend doesn't recognize). Renders
    // as neutral ⚠ rows so the audit trail records what was
    // declared and what the backend evaluated. Does NOT influence
    // state. Approved decision §5.
    if (_unknownChecks.length > 0) {
      readmeLines.push("Unknown (acceptance checks):");
      for (const c of _unknownChecks) {
        readmeLines.push(`  ⚠ ${c.label}`);
        if (c.detail) readmeLines.push(`     ${c.detail}`);
      }
      readmeLines.push("");
    }

    // The "exported despite the readiness gap" honesty paragraph —
    // moved out of the missing branch above so it renders any time
    // state is requirements_missing (regardless of encouraged/unknown
    // structure above).
    if (acceptanceReadiness.state === "requirements_missing") {
      readmeLines.push("This packet was exported with REQUIRED acceptance signals");
      readmeLines.push("unsatisfied. The missing signals are listed above. The operator");
      readmeLines.push("chose to export despite the readiness gap; the audit trail records");
      readmeLines.push("this decision in this packet's metadata: see packet-manifest.json");
      readmeLines.push("(acceptanceReadiness.checks + history[], where each export revision");
      readmeLines.push("is stamped with its generatedAt timestamp and storagePath).");
      readmeLines.push("");
    }

    // PR 104 — Customer Acceptance Criteria section. Prose, NOT
    // machine-evaluated. Rendered only when the snapshot carries
    // acceptanceCriteria (from customer_template or org_template).
    // Approved decision §7. Customer-facing doc never renders this
    // section (don't echo the customer's own words back to them).
    const _criteria = Array.isArray(incident?.requirements?.acceptanceCriteria)
      ? incident.requirements.acceptanceCriteria.map((s) => String(s || "").trim()).filter((s) => s.length > 0)
      : [];
    if (_criteria.length > 0) {
      readmeLines.push("CUSTOMER ACCEPTANCE CRITERIA");
      readmeLines.push("────────────────────────────");
      readmeLines.push("These criteria are stated by the customer template and are");
      readmeLines.push("not machine-evaluated. They are reproduced here for context.");
      readmeLines.push("");
      for (const item of _criteria) {
        readmeLines.push(`  • ${item}`);
      }
      readmeLines.push("");
    }

    // PEAKOPS_PACKET_BRANDING_V1 (Chunk 3B-2, 2026-06-22)
    // String-only branding swap. Operator org name appears in the
    // attribution line; legacy records without a resolvable org doc
    // fall back to the pre-3B-2 generic "PeakOps" string.
    if (_packetOrgName && String(_packetOrgName).trim()) {
      readmeLines.push(`This packet was generated by ${String(_packetOrgName).trim()} · powered by PeakOps.`);
    } else {
      readmeLines.push("This packet was generated by PeakOps.");
    }
    readmeLines.push("");

    await fs.promises.writeFile(path.join(workDir, "README_FIRST.txt"), readmeLines.join("\n"), "utf8");

    // PEAKOPS_REPORT_ENGINE_V1 (2026-04-30)
    // Customer-facing filename — `<title>_<MMMdd>__v<n>.zip`. PR 45
    // adds the version suffix so prior packet versions are retained
    // (per locked decision) rather than overwritten on re-export.
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const today = new Date();
    const stamp = `${months[today.getMonth()]}${String(today.getDate()).padStart(2, "0")}`;
    const titleSlug = slugify(resolvedTitle).slice(0, 60);
    const zipName = `${titleSlug}_${stamp}__v${reportRevision}.zip`;
    const zipPath = path.join(os.tmpdir(), `peakops_${incidentId}_${zipName}`);

    // PEAKOPS_REPORT_CUSTOMER_V1 (2026-05-01)
    // Final pre-ZIP sanity check: list REPORTS/ once more right
    // before runZip to confirm nothing has touched the directory
    // between the customer write and ZIP finalize.
    try {
      const finalReports = await fs.promises.readdir(reportsDir);
      // eslint-disable-next-line no-console
      console.log(
        `[exportIncidentPacketV1] pre-zip REPORTS/:`,
        finalReports.sort().join(", "),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[exportIncidentPacketV1] pre-zip readdir failed:`, e?.message);
    }

    await runZip(workDir, zipPath);

    // PEAKOPS_SEALED_PACKET_V2_VERSIONED_PATH_V1 (2026-05-19, PR 45)
    // Versioned storage path. Prior versions are RETAINED at their
    // original paths (locked decision: keep all forever). The
    // packetMeta.storagePath below points at this latest version;
    // packetMeta.history[].storagePath gives per-version access.
    const outStoragePath = `exports/incidents/${incidentId}/v${reportRevision}__${zipName}`;
    await bucketObj.file(outStoragePath).save(await fs.promises.readFile(zipPath), {
      contentType: "application/zip",
      resumable: false,
      metadata: { cacheControl: "no-store" },
    });

    const url = isEmu() ? emuDownloadUrl(bucket, outStoragePath) : outStoragePath;
    const zipBuf = await fs.promises.readFile(zipPath);
    const zipSha256 = require("crypto").createHash("sha256").update(zipBuf).digest("hex");
    const exportedAt = new Date().toISOString();

    // PEAKOPS_SEALED_PACKET_V2_HISTORY_STORAGE_PATH_V1 (2026-05-19, PR 45)
    // Backfill storagePath on the last entry of reportHistory (which
    // was just appended for this export upstream). Older entries
    // pre-PR-45 don't carry storagePath; that's acceptable — older
    // packets live at their original non-versioned paths and the
    // Summary "Export history" UI in PR 47 will gracefully handle
    // mixed history shapes.
    const reportHistoryWithPath = Array.isArray(reportHistory) ? reportHistory.map((entry, i) => {
      if (i === reportHistory.length - 1 && entry && typeof entry === "object" && !entry.storagePath) {
        return { ...entry, storagePath: outStoragePath };
      }
      return entry;
    }) : reportHistory;

        await incRef.set({
      packetMeta: {
        status: "ready",
        bucket,
        storagePath: outStoragePath,
        exportedAt,
        packetHash: zipSha256,
        sizeBytes: zipBuf.length,
        filingsCount: timeline.length > 0 ? evidence.length : 0,
        timelineCount: timelineNormalized.length,
        zipSha256,
        zipSize: zipBuf.length,
        zipGeneratedAt: exportedAt,
        evidenceCount: evidence.length,
        exportedCount: downloaded.length,
        skippedCount: skipped.length,
        jobCount: approvedJobs.length,
        // PEAKOPS_SEALED_PACKET_V2_PACKETMETA_V1 (2026-05-19, PR 45)
        // Two-section packet markers. PR 46 will populate the hash
        // fields with deterministic byte-stable values; for now they
        // mirror what was emitted into the zip (placeholder
        // original-record hash + real supplemental section hash).
        // PR 98a — bumped 2 → 3 to track requiredProof index in packet-manifest.
        // PR 99 — bumped 3 → 4 for the physical layout migration to
        // required-proof/{slot}/ + unassigned/.
        // PR 103a — bumped 4 → 5 to track the acceptanceReadiness block.
        // PR 104 — bumped 5 → 6 for template-driven acceptance checks
        // (new check categories, satisfied: "unknown" possible value,
        // and snapshotted acceptanceChecks/acceptanceCriteria arrays).
        formatVersion: 6,
        packetVersion: reportRevision,
        originalRecordHash: _originalRecordHash,
        topLevelHash: _topLevelHash,
        supplementalAddendaHash: supplementalSectionHash,
        addendaCount: addendaEmitted.length,
        // PEAKOPS_REGENERATE_GATE_V1 (2026-05-04)
        // Persisted so the next export reads the right base value
        // and increments cleanly — the source of truth for the
        // counter lives on the incident doc, not the ZIP.
        reportRevision,
        // PEAKOPS_REPORT_LINEAGE_V1 (2026-05-04)
        // Source-of-truth history. Persisted append-only on the
        // incident doc; every export reads, appends, writes back.
        // PEAKOPS_SEALED_PACKET_V2 (2026-05-19, PR 45): the latest
        // entry now carries its own storagePath so PR 47's Export
        // History UI can resolve each version's GCS object.
        history: reportHistoryWithPath,
      },
      // PR 103a — Persist the readiness state on the incident doc
      // so Records-page reads can render the pill without a full
      // recompute. cachedAt is the moment of THIS export's compute;
      // getAcceptanceReadinessV1 refreshes it whenever called.
      readinessCache: {
        ...acceptanceReadiness,
        packetRevisionAtComputation: reportRevision,
        cachedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: exportedAt,
    }, { merge: true });

    // PEAKOPS_REPORT_DOWNLOAD_OPAQUE_V1 (2026-05-01)
    // Customer-facing response. No bucket / storagePath / signed URL
    // exposure — those internals stay on `incident.packetMeta` where
    // the opaque /api/reports/<id>/download route reads them
    // server-side. Frontends construct the download URL from
    // (incidentId, orgId) and don't need any GCS information.
    const downloadUrl = `/api/reports/${encodeURIComponent(incidentId)}/download?orgId=${encodeURIComponent(orgId)}`;

    // PEAKOPS_NOTIFICATIONS_PRODUCER_V2 (2026-05-05)
    // report_ready fan-out. Recipients:
    //   - admin members of the org (role-resolved)
    //   - the incident's creator (via additionalUids), even if
    //     they're a `field` user excluded from the admin role
    // Both gated on per-user `reportReadyAlertsEnabled` setting:
    // missing/undefined defaults to opt-IN (the helper treats only an
    // explicit `false` as suppression). Best-effort: a failure here
    // logs but doesn't fail the export — the ZIP is already in
    // Storage and the response below is the user-facing success
    // surface. Single-line `[notify] report_ready recipients=<n>
    // wrote=<n>` so log parsers don't need to stitch lines.
    try {
      if (_notify && typeof _notify.fanOutOrgNotification === "function") {
        // Try the common creator field names — different parts of
        // the app have written this with different shapes; coalesce
        // to whichever is present.
        const _creatorUid =
          String(incident?.createdBy || "").trim() ||
          String(incident?.createdByUid || "").trim() ||
          String(incident?.creatorUid || "").trim();
        const _displayName = resolvedTitle || incidentId;
        const result = await _notify.fanOutOrgNotification({
          orgId,
          recipientRoles: ["admin"],
          additionalUids: _creatorUid ? [_creatorUid] : [],
          settingKey: "reportReadyAlertsEnabled",
          payload: {
            type: "report_ready",
            title: "Report ready",
            message: `${_displayName} report is ready to download.`,
            incidentId,
            orgId,
            targetUrl: `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}`,
          },
        });
        const wrote = typeof result === "number" ? result : (result?.wrote || 0);
        const recipients = typeof result === "number" ? result : (result?.recipients || result?.wrote || 0);
        // eslint-disable-next-line no-console
        console.log(`[notify] report_ready recipients=${recipients} wrote=${wrote}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[notify] _notify helper unavailable — report_ready fan-out skipped");
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[notify] report_ready fan-out failed", e?.message || e);
    }

    return j(res, 200, {
      ok: true,
      incidentId,
      filename: zipName,
      downloadUrl,
      downloaded: downloaded.length,
      skipped: skipped.length,
    });
  } catch (e) {
    // PEAKOPS_REPORT_DEFENSIVE_V1 (2026-05-05)
    // Top-level catch — log the failing incidentId + stack so the
    // crash is greppable in firebase functions:log when the client
    // surface only sees "We couldn't generate the report." UI never
    // gets the raw stack.
    const incidentIdForLog = String(((req && req.body) || {}).incidentId || "");
    // eslint-disable-next-line no-console
    console.error("[export-packet] failed", {
      incidentId: incidentIdForLog,
      message: String(e?.message || e),
      stack: e?.stack ? String(e.stack).split("\n").slice(0, 6).join(" | ") : null,
    });
    return j(res, 500, { ok: false, error: String(e?.message || e || "error") });
  }
});
