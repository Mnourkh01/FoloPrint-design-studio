import Link from 'next/link';
import { apiUrl, fetchDesign, fetchTemplate } from '@/lib/api';
import type { ProductTemplateDto } from '@foloprint/shared';
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

  // Template gives human names for the print area keys; the page still works without it.
  let template: ProductTemplateDto | null = null;
  try {
    template = await fetchTemplate(design.templateSlug);
  } catch {
    template = null;
  }
  const areaName = (key: string) =>
    template?.printAreas.find((a) => a.key === key)?.name ?? key;

  const totalObjects = design.design.placements.reduce((sum, p) => sum + p.objects.length, 0);
  const placedAreas = design.design.placements.map((p) => areaName(p.printAreaKey)).join(', ');

  return (
    <div className="preview-grid">
      <div className="preview-stack" data-testid="preview-stack">
        {design.previews.length > 0 ? (
          design.previews.map((preview) => (
            <div className="preview-frame" key={preview.printAreaKey}>
              <p className="preview-frame__label">
                <b>{areaName(preview.printAreaKey)}</b>
                <span>rendered {new Date(preview.renderedAt).toLocaleString()}</span>
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${apiUrl(preview.previewUrl)}?t=${Date.parse(preview.renderedAt)}`}
                alt={`Rendered ${areaName(preview.printAreaKey)} mockup`}
                data-testid={`preview-image-${preview.printAreaKey}`}
              />
            </div>
          ))
        ) : (
          <div className="preview-frame">
            <div className="preview-frame__empty" data-testid="preview-empty">
              No current previews. The design changed since the last render, or it was never
              rendered. Generate the mockups to refresh them.
            </div>
          </div>
        )}
      </div>

      <div>
        <h1 className="page-title">Your mockups</h1>
        <p className="page-sub">
          Rendered on the server from the saved design, one mockup per printed side.
        </p>

        <dl className="kv">
          <dt>Design id</dt>
          <dd>{design.id}</dd>
          <dt>Template</dt>
          <dd>{design.templateSlug}</dd>
          <dt>Print areas</dt>
          <dd>{placedAreas}</dd>
          <dt>Objects</dt>
          <dd>{totalObjects}</dd>
          <dt>Saved</dt>
          <dd>{new Date(design.createdAt).toLocaleString()}</dd>
        </dl>

        <div className="action-row">
          <RenderButton designId={design.id} hasPreviews={design.previews.length > 0} />
          <Link
            href={`/editor/${design.templateSlug}?design=${design.id}`}
            className="btn btn--ghost btn--auto"
            data-testid="edit-design"
          >
            Edit design
          </Link>
        </div>
        <p style={{ marginTop: 16, display: 'flex', gap: 20 }}>
          <Link href="/designs" className="template-card__cta" data-testid="all-designs">
            All designs
          </Link>
          <Link href={`/editor/${design.templateSlug}`} className="template-card__cta">
            Start a new design on this template
          </Link>
        </p>
      </div>
    </div>
  );
}
