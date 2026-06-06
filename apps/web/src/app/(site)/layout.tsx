import Link from 'next/link';

/** Header/footer shell for every page except the full-screen studio editor. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a href="/" className="topbar__mark">
          FoloPrint <em>Design Studio</em>
        </a>
        <nav className="topbar__nav">
          <Link href="/designs" className="topbar__link" data-testid="nav-designs">
            Design Library
          </Link>
          <span className="topbar__meta">Proof of concept</span>
        </nav>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        <span>FoloPrint Design Studio</span>
        <span>Standalone editor, not connected to the store</span>
      </footer>
    </div>
  );
}
