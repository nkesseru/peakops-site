"use client";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html>
      <body className="p-10">
        <h1 className="text-2xl font-bold">App Error</h1>
        <p className="text-sm text-gray-600">We hit an unexpected issue.</p>
        <pre className="text-xs bg-gray-100 p-3 rounded mt-2 overflow-auto">{error.message}</pre>
        <button className="mt-4 px-3 py-2 rounded border" onClick={() => reset()}>
          Retry
        </button>
      </body>
    </html>
  );
}
