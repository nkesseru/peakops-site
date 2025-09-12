import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'PeakOps Portal', description: 'Customer portal' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body className="bg-[#F5FAFF] text-[#0B0F14]">{children}</body></html>
  );
}
