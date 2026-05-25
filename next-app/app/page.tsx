import { redirect } from "next/navigation";

// PEAKOPS_HIDE_PASTE_FORM_V1
// The previous /page.tsx rendered a "paste an incident ID" raw-HTML
// form in production (and a dev-mode redirect to inc_demo). Both
// were leftover scaffolding from before the dashboard existed. Any
// customer or stakeholder typing app.peakops.app directly was the
// most likely off-path landmine in the demo.
//
// Server-side redirect to /dashboard. From there, RequireAuth bounces
// anonymous visitors to /login (post-login they return to /dashboard
// via the existing peakops_return_to chain). Signed-in users land
// directly on the dashboard hero card.
export default function HomePage() {
  redirect("/dashboard");
}
