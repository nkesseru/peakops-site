import { set, get, del, keys } from "idb-keyval";

type Actor = { role: string; id?: string };

type OutboxItem =
  | { id: string; type: "SUPERVISOR_REQUEST_UPDATE"; incidentId: string; message: string; actor: Actor; createdAtMs: number }
  | { id: string; type: "SUPERVISOR_REQUEST_CLEAR"; incidentId: string; actor: Actor; createdAtMs: number };

const PREFIX = "peakops_outbox_supervisor_request_";
const k = (id: string) => PREFIX + id;
const mkId = () => "oru_" + Date.now() + "_" + Math.random().toString(16).slice(2);

async function fetchWithTimeout(input: RequestInfo, init: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal, cache: "no-store" as any });
  } finally {
    clearTimeout(t);
  }
}

export async function enqueueSupervisorRequestUpdate(args: { incidentId: string; message: string; actor: Actor }) {
  const id = mkId();
  const item: OutboxItem = {
    id,
    type: "SUPERVISOR_REQUEST_UPDATE",
    incidentId: String(args.incidentId || ""),
    message: String(args.message || ""),
    actor: args.actor || { role: "supervisor" },
    createdAtMs: Date.now(),
  };
  await set(k(id), item);
  return id;
}

export async function enqueueSupervisorRequestClear(args: { incidentId: string; actor: Actor }) {
  const id = mkId();
  const item: OutboxItem = {
    id,
    type: "SUPERVISOR_REQUEST_CLEAR",
    incidentId: String(args.incidentId || ""),
    actor: args.actor || { role: "field" },
    createdAtMs: Date.now(),
  };
  await set(k(id), item);
  return id;
}

export async function outboxFlushSupervisorRequests(): Promise<{ flushed: number; kept: number }> {
  let flushed = 0, kept = 0;

  let ks: any[] = [];
  try {
    ks = (await keys()).filter((x) => typeof x === "string" && String(x).startsWith(PREFIX));
  } catch {
    return { flushed: 0, kept: 0 };
  }

  for (const key of ks) {
    try {
      const item = (await get(String(key))) as OutboxItem | undefined;
      if (!item?.id) { await del(String(key)); continue; }

      if (item.type === "SUPERVISOR_REQUEST_UPDATE") {
        const res = await fetchWithTimeout("/api/supervisor-request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ incidentId: item.incidentId, message: item.message, actor: item.actor, source: "outbox", outboxId: item.id }),
        }, 6000);
        if (res.ok) { await del(String(key)); flushed++; } else { kept++; }
      }

      if (item.type === "SUPERVISOR_REQUEST_CLEAR") {
        const res = await fetchWithTimeout("/api/supervisor-request", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ incidentId: item.incidentId, actor: item.actor, source: "outbox", outboxId: item.id }),
        }, 6000);
        if (res.ok) { await del(String(key)); flushed++; } else { kept++; }
      }
    } catch {
      kept++;
    }
  }

  return { flushed, kept };
}
