"use client";

/**
 * PEAKOPS_APP_TOP_BAR_V2 (PR 75 — Workflow Spine Foundation)
 *
 * Universal authenticated chrome. v1 (PR 67) was a back-home strip
 * with PEAKOPS wordmark + Dashboard link + "+ New field record".
 * v2 adds the workflow spine: a short list of nav links between
 * record-creating moments and a read-only org chip so the user
 * always knows which packet stream they're acting against.
 *
 * Voice stays dossier-adjacent. NOT an app shell — no sidebar, no
 * hamburger, no profile dropdown, no notifications, no search. The
 * top bar exists to:
 *   - tell you where you are (active route, org)
 *   - let you reach the four primary surfaces (Dashboard, Records,
 *     My Work, Team) from anywhere
 *   - put the create CTA in a stable place
 *
 * Role-aware visibility:
 *   - Team item renders only for owner | admin | supervisor. Field
 *     and viewer roles never see it, because the Rapid Access
 *     Recovery surface at /team is supervisor-only and showing the
 *     link to other roles would be a confusing dead end.
 *   - + New field record button stays visible to every role for now
 *     — the server enforces role at /api/fn/createIncidentV1
 *     (ROLES_FIELD_WORK). A future PR could hide the button from
 *     viewer-only sessions.
 *
 * Active-route highlighting:
 *   - Current path renders with brighter text (text-gray-100), no
 *     onClick. Inactive items hover-lift to text-gray-100. Matches
 *     the RecordNav (PR 66) treatment so the visual vocabulary is
 *     consistent across the two nav strips.
 *
 * Org chip:
 *   - Read-only in this PR. Shows claims.orgIds[0] lowercased. When
 *     the user has ≥2 claim'd orgs we still only show the active one
 *     — the switcher comes in PR 77.
 *
 * Non-sticky. Sits at the top of the page, scrolls with the body.
 * Sticky regions on individual pages continue to behave as before.
 *
 * Mount per-page (inside each surface's RequireAuth tree) — never
 * leaks onto /login or /auth/action.
 */

import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

const TEAM_ROLES = new Set(["owner", "admin", "supervisor"]);

type NavItem = {
  key: string;
  label: string;
  href: string;
  /** Optional role allowlist. Omit to show to all roles. */
  roles?: Set<string>;
};

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard" },
  { key: "records", label: "Records", href: "/records" },
  { key: "my-work", label: "My Work", href: "/my-work" },
  { key: "team", label: "Team", href: "/team", roles: TEAM_ROLES },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AppTopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const { claims } = useAuth();
  const role = String(claims?.role || "").toLowerCase();
  const orgId = (claims?.orgIds || [])[0] || "";

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || item.roles.has(role));

  return (
    <div className="w-full border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70 hover:text-amber-100 transition-colors"
            aria-label="PeakOps home"
          >
            PEAKOPS
          </button>

          {/* PEAKOPS_APP_TOP_BAR_V2 — read-only org chip. Renders only
              when a claim'd orgId is present. PR 77 turns this into a
              switcher when claims.orgIds.length >= 2. */}
          {orgId ? (
            <>
              <span aria-hidden="true" className="text-white/20 text-[11px]">
                ·
              </span>
              <span
                className="text-[10px] uppercase tracking-[0.14em] font-medium text-gray-400"
                title="Current organization"
              >
                {orgId}
              </span>
            </>
          ) : null}

          <nav
            aria-label="Primary"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 ml-2"
          >
            {visibleItems.map((item, i) => {
              const active = isActive(pathname, item.href);
              return (
                <span key={item.key} className="flex items-center gap-3">
                  {i > 0 ? (
                    <span aria-hidden="true" className="text-white/20 text-[11px]">
                      ·
                    </span>
                  ) : null}
                  {active ? (
                    <span
                      className="text-[12px] font-medium text-gray-100 cursor-default"
                      aria-current="page"
                    >
                      {item.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => router.push(item.href)}
                      className="text-[12px] font-medium text-gray-400 hover:text-gray-100 transition-colors"
                    >
                      {item.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {/* PEAKOPS_FRAMING_LAYER_V1 (PR 72) — button label aligned
              with the "Field record" vocabulary from PR 71. The
              route still lives at /incidents/new for back-compat. */}
          <button
            type="button"
            onClick={() => router.push("/incidents/new")}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
            title="Open a new field record"
          >
            + New field record
          </button>
        </div>
      </div>
    </div>
  );
}
