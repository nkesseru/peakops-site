"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="p-10">
      <h2 className="text-2xl font-bold mb-2">Something went wrong</h2>
      <pre className="text-sm bg-gray-100 p-3 rounded overflow-auto">{error.message}</pre>
      <button className="mt-4 px-4 py-2 rounded bg-black text-white" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
