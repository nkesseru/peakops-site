import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1>PeakOps</h1>
      <p>Welcome. Useful links:</p>
      <ul>
        <li><Link href="/about">About</Link></li>
        <li><Link href="/mission-control">Mission Control</Link></li>
        <li><a href="/api/ping2" target="_blank" rel="noreferrer">/api/ping2</a></li>
        <li><a href="/api/env-check" target="_blank" rel="noreferrer">/api/env-check</a></li>
        <li><a href="/api/deploy-info" target="_blank" rel="noreferrer">/api/deploy-info</a></li>
        <li><a href="/api/admin-health" target="_blank" rel="noreferrer">/api/admin-health</a></li>
      </ul>
    </main>
  );
}
