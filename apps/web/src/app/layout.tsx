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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${archivo.variable}`}>
      <body>
        <div className="shell">
          <header className="topbar">
            <a href="/" className="topbar__mark">
              FoloPrint <em>Design Studio</em>
            </a>
            <span className="topbar__meta">Proof of concept</span>
          </header>
          <main className="main">{children}</main>
          <footer className="footer">
            <span>FoloPrint Design Studio</span>
            <span>Standalone editor, not connected to the store</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
