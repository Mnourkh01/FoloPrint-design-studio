import type { Metadata } from 'next';
import { Archivo, Fraunces } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  weight: ['400', '600'],
  style: ['normal', 'italic'],
});

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'FoloPrint Design Studio',
  description: 'Place your artwork on real products and get a production-style mockup back.',
};

/**
 * Root layout carries only fonts and the document shell. Page chrome lives in the
 * route groups: (site) wraps marketing/library pages in the header/footer shell,
 * (studio) renders the full-screen editor with no chrome at all.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${archivo.variable}`}>
      <body>{children}</body>
    </html>
  );
}
