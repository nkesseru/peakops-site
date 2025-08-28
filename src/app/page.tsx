export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1>PeakOps Next</h1>
      <p>Welcome. API endpoints available:</p>
      <ul>
        <li><a href="/api/ping2">/api/ping2</a></li>
        <li><a href="/api/seed">/api/seed</a></li>
      </ul>
    </main>
  );
}
