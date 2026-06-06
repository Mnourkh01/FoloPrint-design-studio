import Link from 'next/link';
import { fetchDesign, fetchTemplate } from '@/lib/api';
import type { DesignProjectDto } from '@foloprint/shared';
import { EditorClient } from './editor-client';

export const dynamic = 'force-dynamic';

/** Centered fallback for load errors; the studio layout has no site chrome. */
function StudioNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="studio-notice">
      <div className="notice">{children}</div>
    </div>
  );
}

export default async function EditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ templateSlug: string }>;
  searchParams: Promise<{ design?: string }>;
}) {
  const { templateSlug } = await params;
  const { design: designId } = await searchParams;

  try {
    const template = await fetchTemplate(templateSlug);

    let initialDesign: DesignProjectDto | undefined;
    if (designId) {
      try {
        initialDesign = await fetchDesign(designId);
      } catch {
        return (
          <StudioNotice>
            <strong>Saved design not found.</strong>
            <p>
              The design <code>{designId}</code> does not exist anymore.{' '}
              <Link href={`/editor/${templateSlug}`}>Start a fresh design</Link> instead.
            </p>
          </StudioNotice>
        );
      }
      if (initialDesign.templateSlug !== templateSlug) {
        return (
          <StudioNotice>
            <strong>This design belongs to a different template.</strong>
            <p>
              Open it on its own template instead:{' '}
              <Link href={`/editor/${initialDesign.templateSlug}?design=${initialDesign.id}`}>
                {initialDesign.templateSlug}
              </Link>
            </p>
          </StudioNotice>
        );
      }
    }

    return <EditorClient template={template} initialDesign={initialDesign} />;
  } catch {
    return (
      <StudioNotice>
        <strong>Could not load this template.</strong>
        <p>
          Check that the API is running and the template <code>{templateSlug}</code> exists, then
          refresh. <Link href="/">Back to templates</Link>.
        </p>
      </StudioNotice>
    );
  }
}
