// PR 134A.1 — Onboarding-status read for the WelcomeFirstRun card.
//
// Returns the three signals the Butler dry-run identified as missing
// from the customer admin's first-screen experience: (a) activation
// confirmation (org doc exists), (b) starter-template-ready callout
// (template doc exists + summary), (c) team-invite confirmation
// (member count + per-member status). Also returns incidentCount so
// the card can hide itself once the customer has real workflow data.
//
// Auth: standard bearer-token gate via verifyAuthHeader. The caller's
// orgIds claim must include the requested orgId — refuses 403 if not.
// Defense-in-depth: same gate the gated callables use, so the welcome
// card can never read a foreign org's onboarding state.

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyAuthHeader, AuthError } from "@/lib/verifyAuth";

interface OrgMemberDoc {
  role?: string;
  displayName?: string;
  email?: string;
  status?: string;
  joinedAt?: unknown;
}

interface OrgTemplateDoc {
  label?: string;
  title?: string;
  requiredProof?: unknown[];
  acceptanceChecks?: unknown[];
}

export async function GET(req: Request) {
  try {
    const decoded = await verifyAuthHeader(req);
    const url = new URL(req.url);
    const orgId = String(url.searchParams.get("orgId") || "").trim();
    if (!orgId) {
      return NextResponse.json({ ok: false, error: "orgId required" }, { status: 400 });
    }
    const orgIds = Array.isArray((decoded as any).orgIds) ? (decoded as any).orgIds : [];
    if (!orgIds.includes(orgId)) {
      return NextResponse.json({ ok: false, error: "permission-denied" }, { status: 403 });
    }

    const db = getAdminDb();
    // Three parallel reads — org doc, members subcollection, starter template.
    // Members are capped at 50 just to keep the wire payload bounded; the
    // welcome card only needs the count + a few entries for display.
    const [orgSnap, membersSnap, templatesSnap] = await Promise.all([
      db.doc(`orgs/${orgId}`).get(),
      db.collection(`orgs/${orgId}/members`).limit(50).get(),
      db.collection(`orgs/${orgId}/templates`).limit(10).get(),
    ]);

    if (!orgSnap.exists) {
      return NextResponse.json({ ok: false, error: "org_not_found" }, { status: 404 });
    }

    const org = orgSnap.data() || {};
    const members = membersSnap.docs.map((d) => {
      const m = (d.data() || {}) as OrgMemberDoc;
      return {
        uid: d.id,
        role: String(m.role || ""),
        displayName: String(m.displayName || m.email || ""),
        email: String(m.email || ""),
        status: String(m.status || ""),
        joinedAt: m.joinedAt || null,
      };
    });

    // Starter template is the first template doc the activation flow
    // seeds (Chunk 3B-2). We surface its key + counts so the card can
    // say "fiber_splice_verification · 5 required-proof · 5 acceptance
    // checks ready" rather than a generic "template ready" claim.
    const templates = templatesSnap.docs.map((d) => {
      const t = (d.data() || {}) as OrgTemplateDoc;
      return {
        key: d.id,
        label: String(t.label || t.title || d.id),
        requiredProofCount: Array.isArray(t.requiredProof) ? t.requiredProof.length : 0,
        acceptanceCheckCount: Array.isArray(t.acceptanceChecks) ? t.acceptanceChecks.length : 0,
      };
    });

    // Incident count drives the card's auto-hide behavior. We only
    // need to know whether ANY incidents exist — the welcome surface
    // disappears the moment real workflow data flows in. Capped at 1
    // for cheapness; "exists" is the only signal we use.
    const incCountSnap = await db.collection(`orgs/${orgId}/incidents`).limit(1).get();
    const hasIncidents = !incCountSnap.empty;

    return NextResponse.json({
      ok: true,
      orgId,
      orgName: String(org.name || orgId),
      industry: String(org.industry || ""),
      members,
      teammateCount: members.filter((m) => m.role !== "owner").length,
      ownerCount: members.filter((m) => m.role === "owner").length,
      starterTemplate: templates[0] || null,
      starterTemplateCount: templates.length,
      hasIncidents,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    console.error("[onboarding-status] failed", e);
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
