import Link from 'next/link';
import { fetchTemplate } from '@/lib/api';
import { EditorClient } from './editor-client';

export const dynamic = 'force-dynamic';

export default async function EditorPage({
  params,
}: {
  params: Promise<{ templateSlug: string }>;
}) {
  const { templateSlug } = await params;

  try {
    const template = await fetchTemplate(templateSlug);
    return (
      <>
        <div className="editor-head">
          <h1>{template.name}</h1>
          <span className="crumb">
            <Link href="/">Templates</Link> / {template.slug}
          </span>
        </div>
        <EditorClient template={template} />
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
