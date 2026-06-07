import Link from 'next/link';
import { apiUrl, fetchTemplates } from '@/lib/api';
import type { ProductTemplateDto } from '@foloprint/shared';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let templates: ProductTemplateDto[] = [];
  let apiDown = false;

  try {
    templates = await fetchTemplates();
  } catch {
    apiDown = true;
  }

  return (
    <section className="hero">
      <header className="hero__head">
        <div>
          <p className="hero__eyebrow">Sample run</p>
          <h1 className="hero__title">
            Put your mark <em>on it.</em>
          </h1>
        </div>
        <div className="hero__aside">
          <p className="hero__lede">
            Pick a product, drop your logo inside the print area, and get a production-style
            mockup rendered on the server. No account, no checkout, just the editor.
          </p>
          <p className="hero__meta">
            PNG and JPEG uploads, 10 MB max. Designs are validated against the print area on the
            server before anything is rendered.
          </p>
        </div>
      </header>

      {apiDown ? (
        <div className="notice">
          <strong>API is not reachable.</strong>
          <p>
            Start it with <code>npm run db:up</code>, <code>npm run db:seed</code> and{' '}
            <code>npm run dev:api</code>, then refresh this page.
          </p>
        </div>
      ) : templates.length === 0 ? (
        <div className="notice">
          <strong>No templates seeded yet.</strong>
          <p>
            Run <code>npm run db:seed</code> to create the sample tee.
          </p>
        </div>
      ) : (
        <div className="hero__grid">
          {templates.map((template) => (
            <Link
              key={template.id}
              href={`/editor/${template.slug}`}
              className="template-card"
              data-testid={`template-${template.slug}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="template-card__image"
                src={apiUrl(template.thumbUrl ?? template.imageUrl)}
                alt={template.name}
              />
              <span className="template-card__body">
                <span>
                  <span className="template-card__name">{template.name}</span>
                  <span className="template-card__spec">
                    {template.canvasWidth} x {template.canvasHeight} px canvas ·{' '}
                    {template.printAreas.length} print area
                    {template.printAreas.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="template-card__cta">Open editor</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
