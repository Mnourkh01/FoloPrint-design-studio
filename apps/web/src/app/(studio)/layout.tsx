/**
 * Full-screen chrome-less layout for the studio editor: the editor owns the entire
 * viewport (its own topbar, tool rail, workspace, and bottom bar).
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return <div className="studio-root">{children}</div>;
}
