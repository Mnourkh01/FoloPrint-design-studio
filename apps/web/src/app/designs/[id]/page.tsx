import Link from 'next/link';
import { apiUrl, fetchDesign } from '@/lib/api';
import { RenderButton } from './render-button';

export const dynamic = 'force-dynamic';

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let design;
  try {
    design = await fetchDesign(id);
  } catch {
    return (
      <div className="notice">
        <strong>Design not found.</strong>
        <p>
          It may have been removed, or the API is offline. <Link href="/">Back to templates</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="preview-grid">
      <div className="preview-frame">
        {design.previewUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`${apiUrl(design.previewUrl)}?t=${Date.parse(design.updatedAt)}`}
            alt="Rendered product mockup"
            data-testid="preview-image"
          />
        ) : (
          <div className="preview-frame__empty" data-testid="preview-empty">
            Not rendered yet. Generate the mockup to see it here.
          </div>
        )}
      </div>

      <div>
        <h1 className="page-title">Your mockup</h1>
        <p className="page-sub">
          Rendered on the server from the saved design, not a screenshot of the editor.
        </p>

        <dl className="kv">
          <dt>Design id</dt>
          <dd>{design.id}</dd>
          <dt>Template</dt>
          <dd>{design.templateSlug}</dd>
          <dt>Print area</dt>
          <dd>{design.design.printAreaKey}</dd>
          <dt>Objects</dt>
          <dd>{design.design.objects.length}</dd>
          <dt>Saved</dt>
          <dd>{new Date(design.createdAt).toLocaleString()}</dd>
        </dl>

        <RenderButton designId={design.id} hasPreview={Boolean(design.previewUrl)} />
        <p style={{ marginTop: 16 }}>
          <Link href={`/editor/${design.templateSlug}`} className="template-card__cta">
            Start a new design on this template
          </Link>
        </p>
      </div>
    </div>
  );
}
