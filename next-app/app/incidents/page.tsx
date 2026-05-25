import { redirect } from "next/navigation";

// PEAKOPS_HIDE_PASTE_FORM_V1
// The previous /incidents/page.tsx rendered a "paste an incident ID"
// raw-HTML form with example links — leftover scaffolding from before
// the dashboard existed. The Dashboard's "Continue your demo" hero
// card is the canonical entry point now; this index just redirects
// to it. RequireAuth handles the anonymous case.
export default function IncidentsIndexPage() {
  redirect("/dashboard");
}
