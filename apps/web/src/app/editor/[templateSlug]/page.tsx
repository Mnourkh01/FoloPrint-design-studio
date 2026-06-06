import Link from 'next/link';
import { fetchDesign, fetchTemplate } from '@/lib/api';
import type { DesignProjectDto } from '@foloprint/shared';
import { EditorClient } from './editor-client';

export const dynamic = 'force-dynamic';

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
          <div className="notice">
            <strong>Saved design not found.</strong>
            <p>
              The design <code>{designId}</code> does not exist anymore.{' '}
              <Link href={`/editor/${templateSlug}`}>Start a fresh design</Link> instead.
            </p>
          </div>
        );
      }
      if (initialDesign.templateSlug !== templateSlug) {
        return (
          <div className="notice">
            <strong>This design belongs to a different template.</strong>
            <p>
              Open it on its own template instead:{' '}
              <Link href={`/editor/${initialDesign.templateSlug}?design=${initialDesign.id}`}>
                {initialDesign.templateSlug}
              </Link>
            </p>
          </div>
        );
      }
    }

    return (
      <>
        <div className="editor-head">
          <h1>{template.name}</h1>
          <span className="crumb">
            <Link href="/">Templates</Link> / {template.slug}
            {initialDesign ? <> / design {initialDesign.id.slice(0, 8)}</> : null}
          </span>
        </div>
        <EditorClient template={template} initialDesign={initialDesign} />
      </>
    );
  } catch {
    return (
      <div className="notice">
        <strong>Could not load this template.</strong>
        <p>
          Check that the API is running and the template <code>{templateSlug}</code> exists, then
          refresh. <Link href="/">Back to templates</Link>.
        </p>
      </div>
    );
  }
}
