// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// React hook to resolve uid → display name via listOrgMembersV1.
// Fetches once per orgId per page load, returns a stable Map.
// Used by Queue and Detail to replace raw UIDs with readable names.
//
// Fallback policy: if the lookup hasn't loaded yet OR the uid isn't
// in the response, we return the uid itself as the display string.

"use client";

import { useEffect, useState, useMemo } from "react";
import { authedFetch } from "@/lib/apiClient";

type MemberLite = {
  uid: string;
  displayName?: string;
  email?: string;
  name?: string;
  fullName?: string;
};

export function useMemberNames(orgId: string, actorUid: string) {
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<MemberLite[]>([]);

  useEffect(() => {
    if (!orgId || !actorUid) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/fn/listOrgMembersV1?orgId=${encodeURIComponent(orgId)}&actorUid=${encodeURIComponent(actorUid)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: any = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && Array.isArray(out.members)) {
          setMembers(out.members);
        }
      } catch {
        // Non-fatal: hook returns uid-as-display as fallback.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, actorUid]);

  const nameByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (!m.uid) continue;
      const name = String(m.displayName || m.name || m.fullName || m.email || "").trim();
      map.set(m.uid, name || m.uid);
    }
    return map;
  }, [members]);

  function resolve(uid: string | undefined | null): string {
    const u = String(uid || "").trim();
    if (!u) return "";
    return nameByUid.get(u) || u;
  }

  return { loaded, resolve };
}
