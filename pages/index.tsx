export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1>PeakOps</h1>
      <p>Welcome. Useful links:</p>
      <ul>
        <li><a href="/api/ping2">/api/ping2</a></li>
        <li><a href="/api/seed">/api/seed</a></li>
        <li><a href="/mission-control">Mission Control</a></li>
        <li><a href="/about">About</a></li>
      </ul>
    </main>
  );
}
