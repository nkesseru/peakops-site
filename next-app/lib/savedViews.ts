// PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05)
// Per-user saved filter configurations for Mission Control. Stored
// at users/{uid}/savedViews/{viewId} so each user sees only their
// own views — security rules gate read+write to the owning uid.
//
// `filters` is a small JSON blob mirroring Mission Control's URL
// params: status, vendor (vendor's id), date. Empty/null values are
// stored explicitly so a saved view's "no status" intent doesn't
// accidentally inherit the user's current status when re-applied.
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  type CollectionReference,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "./firebaseClient";

export type SavedFilters = {
  status: string | null;   // ChipKey value, e.g. "in_progress"
  vendor: string | null;   // vendorId — slug isn't stable across renames
  date: string | null;     // "today" | "7d" | "30d"
};

export type SavedView = {
  id: string;
  name: string;
  filters: SavedFilters;
  createdAt?: any;
};

// PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05)
// Cap per spec — keeps the dropdown scannable and the doc count
// per user bounded. Enforced at the helper, surfaced by the UI as
// a disabled Save button + toast.
export const MAX_SAVED_VIEWS = 10;

function viewsCol(uid: string): CollectionReference {
  return collection(db, "users", uid, "savedViews");
}

function viewRef(uid: string, viewId: string): DocumentReference {
  return doc(db, "users", uid, "savedViews", viewId);
}

function coerceFilters(raw: any): SavedFilters {
  const f = raw && typeof raw === "object" ? raw : {};
  return {
    status: typeof f.status === "string" && f.status ? f.status : null,
    vendor: typeof f.vendor === "string" && f.vendor ? f.vendor : null,
    date: typeof f.date === "string" && f.date ? f.date : null,
  };
}

function coerceView(id: string, raw: any): SavedView | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    filters: coerceFilters(raw.filters),
    createdAt: raw.createdAt || null,
  };
}

export async function loadSavedViews(uid: string): Promise<SavedView[]> {
  if (!uid) return [];
  const snap = await getDocs(viewsCol(uid));
  const out: SavedView[] = [];
  snap.forEach((d) => {
    const v = coerceView(d.id, d.data());
    if (v) out.push(v);
  });
  // Newest first — recency bias matches how operators think
  // ("the view I just saved should be at the top").
  out.sort((a, b) => {
    const am = msFromTimestamp(a.createdAt);
    const bm = msFromTimestamp(b.createdAt);
    return bm - am;
  });
  return out;
}

function msFromTimestamp(v: any): number {
  try {
    if (!v) return 0;
    if (typeof v?.toDate === "function") return v.toDate().getTime();
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}

export class SavedViewsLimitError extends Error {
  constructor() {
    super(`saved_views_limit_reached_${MAX_SAVED_VIEWS}`);
    this.name = "SavedViewsLimitError";
  }
}

// PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
// Distinct error so the UI can surface the exact "duplicate name"
// copy without parsing free-text messages. Compares trimmed +
// lowercased names — operators don't think of "Acme" vs "acme" as
// different views.
export class SavedViewsDuplicateError extends Error {
  constructor() {
    super("saved_view_duplicate_name");
    this.name = "SavedViewsDuplicateError";
  }
}

export type SaveViewOptions = {
  // Either pass `existingCount` (cheap path — caller already counted)
  // or `existingViews` (full check — also gates on name uniqueness).
  // The UI passes existingViews so it gets both gates; programmatic
  // callers can pass just the count.
  existingCount?: number;
  existingViews?: SavedView[];
};

export async function saveView(
  uid: string,
  name: string,
  filters: SavedFilters,
  opts: SaveViewOptions = {},
): Promise<string> {
  if (!uid) throw new Error("uid required");
  const trimmedName = String(name || "").trim().slice(0, 60);
  if (!trimmedName) throw new Error("name required");

  // PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05)
  // Soft cap enforced at the helper. The caller (Mission Control)
  // already disables the Save button when at the limit; this is
  // the belt-and-braces check for any programmatic caller.
  const count = typeof opts.existingCount === "number"
    ? opts.existingCount
    : (Array.isArray(opts.existingViews) ? opts.existingViews.length : undefined);
  if (typeof count === "number" && count >= MAX_SAVED_VIEWS) {
    throw new SavedViewsLimitError();
  }

  // PEAKOPS_MC_SAVED_VIEWS_V1_1 (2026-05-05)
  // Duplicate-name check. Case-insensitive trim comparison. Race
  // possible if two tabs save the same name simultaneously — worst
  // case is one duplicate row, surfaced on the next load. v1
  // accepts that trade-off.
  if (Array.isArray(opts.existingViews)) {
    const target = trimmedName.toLowerCase();
    const dup = opts.existingViews.find(
      (v) => String(v.name || "").trim().toLowerCase() === target,
    );
    if (dup) throw new SavedViewsDuplicateError();
  }

  const ref = await addDoc(viewsCol(uid), {
    name: trimmedName,
    filters: coerceFilters(filters),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function deleteView(uid: string, viewId: string): Promise<void> {
  if (!uid || !viewId) throw new Error("uid and viewId required");
  await deleteDoc(viewRef(uid, viewId));
}

// PEAKOPS_MC_SAVED_VIEWS_V1 (2026-05-05)
// Equality check used by the UI to decide whether a saved view is
// "currently applied" (so it can show a Delete affordance for that
// specific view). Strict — null vs "" matter, since both modes
// represent "this filter is not active" but only `null` is what
// we persist on save.
export function filtersEqual(a: SavedFilters, b: SavedFilters): boolean {
  return (
    (a.status || null) === (b.status || null) &&
    (a.vendor || null) === (b.vendor || null) &&
    (a.date || null) === (b.date || null)
  );
}
