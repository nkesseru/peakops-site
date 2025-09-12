import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { Navbar } from '@/components/Navbar';

const inter = Inter({ subsets: ['latin'] });
export const metadata: Metadata = {
  title: 'PeakOps — Elegant field operations',
  description: 'Glassy, fast, and reliable ops for service teams.'
};

export default function RootLayout({children}:{children: React.ReactNode}){
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Navbar/>
          <main>{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
