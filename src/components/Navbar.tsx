import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="bg-gray-100 px-6 py-3 flex gap-6">
      <Link href="/" className="font-medium">Home</Link>
      <Link href="/about" className="font-medium">About</Link>
      <Link href="/api/hello" className="text-sm underline">API: /hello</Link>
      <Link href="/api/ping" className="text-sm underline">API: /ping</Link>
    </nav>
  );
}
