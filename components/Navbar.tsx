'use client';
import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle';
export function Navbar(){
  return (
    <div className="sticky top-0 z-50">
      <div className="glass round-24 mx-auto mt-4 max-w-7xl px-4 py-3">
        <div className="flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight">PeakOps</Link>
          <nav className="hidden md:flex items-center gap-6 text-[14px] text-text-secondary">
            <Link href="#features">Features</Link>
            <Link href="#industries">Industries</Link>
            <Link href="#pricing">Pricing</Link>
            <Link href="#contact">Contact</Link>
          </nav>
          <div className="flex items-center gap-3">
            <ThemeToggle/>
            <Link href="/app" className="btn btn-primary">Open App</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
