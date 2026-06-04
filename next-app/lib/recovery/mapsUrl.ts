// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// Build a Google Maps URL for a free-text address. Per planning,
// this format works on every device: opens the native Maps app on
// mobile and the web Maps client on desktop. No user-agent sniffing.

export function googleMapsUrl(address: string): string {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}
