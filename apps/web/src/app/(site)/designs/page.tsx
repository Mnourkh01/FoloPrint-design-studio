import Link from 'next/link';
import type { Metadata } from 'next';
import { apiUrl, fetchDesigns } from '@/lib/api';
import type { DesignListDto } from '@foloprint/shared';
import { DesignCardActions } from './design-card-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Design Library · FoloPrint Design Studio',
};

export default async function DesignLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const requested = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(requested) && requested > 0 ? requested : 1;

  let list: DesignListDto;
  try {
    list = await fetchDesigns(page);
  } catch {
    return (
      <div className="notice">
        <strong>API is not reachable.</strong>
        <p>
          Start it with <code>npm run db:up</code>, <code>npm run db:seed</code> and{' '}
          <code>npm run dev:api</code>, then refresh this page.
        </p>
      </div>
    );
  }

  return (
    <section>
      <div className="library-head">
        <div>
          <h1 className="page-title">Design Library</h1>
          <p className="page-sub">
            Saved designs, newest first. Open one to view its mockups or keep editing.
          </p>
        </div>
        {list.totalItems > 0 && (
          <p className="library-count" data-testid="library-count">
            <b>{list.totalItems}</b> saved design{list.totalItems === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {list.totalItems === 0 ? (
        <div className="notice" data-testid="library-empty">
          <strong>No saved designs yet.</strong>
          <p>Open the sample tee, place your artwork, and save. Saved designs show up here.</p>
          <p style={{ marginTop: 14, marginBottom: 4 }}>
            <Link
              href="/editor/classic-tee"
              className="btn btn--accent btn--auto"
              data-testid="library-empty-cta"
            >
              Open the editor
            </Link>
          </p>
        </div>
      ) : list.items.length === 0 ? (
        <div className="notice" data-testid="library-page-empty">
          <strong>Nothing on this page.</strong>
          <p>
            <Link href="/designs">Back to the first page</Link>.
          </p>
        </div>
      ) : (
        <>
          <div className="library-grid">
            {list.items.map((item) => (
              <article className="design-card" key={item.id} data-testid={`design-card-${item.id}`}>
                <Link
                  href={`/designs/${item.id}`}
                  className="design-card__thumbs"
                  aria-label={`View ${item.template.name} mockups`}
                >
                  {item.previews.length > 0 ? (
                    item.previews.map((preview) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={preview.printAreaKey}
                        src={`${apiUrl(preview.previewUrl)}?t=${Date.parse(preview.renderedAt)}`}
                        alt={`${item.template.name} ${preview.printAreaKey} mockup`}
                        data-testid={`design-card-thumb-${preview.printAreaKey}`}
                      />
                    ))
                  ) : (
                    <span className="design-card__placeholder" data-testid="design-card-no-preview">
                      No preview rendered
                    </span>
                  )}
                </Link>
                <div className="design-card__body">
                  <p className="design-card__name">{item.template.name}</p>
                  <p className="design-card__meta">
                    updated {new Date(item.updatedAt).toLocaleString()}
                  </p>
                  <p className="design-card__chips" data-testid="design-card-areas">
                    {item.color && (
                      <span className="chip chip--color" data-testid="design-card-color">
                        <i className="chip__swatch" style={{ background: item.color.hex }} />
                        {item.color.name}
                      </span>
                    )}
                    {item.placements.length > 0 ? (
                      item.placements.map((placement) => (
                        <span className="chip" key={placement.printAreaKey}>
                          {placement.printAreaName} · {placement.objectCount} object
                          {placement.objectCount === 1 ? '' : 's'}
                        </span>
                      ))
                    ) : (
                      <span className="chip chip--muted">Unreadable design</span>
                    )}
                    {(item.worstQualityLevel === 'warning' || item.worstQualityLevel === 'poor') && (
                      <span
                        className={`chip chip--quality-${item.worstQualityLevel}`}
                        data-testid="quality-badge"
                      >
                        {item.worstQualityLevel === 'poor' ? 'low res artwork' : 'may print soft'}
                      </span>
                    )}
                  </p>
                  <div className="design-card__actions">
                    <Link
                      href={`/designs/${item.id}`}
                      className="btn btn--ghost"
                      data-testid="design-card-view"
                    >
                      View mockups
                    </Link>
                    <Link
                      href={`/editor/${item.template.slug}?design=${item.id}`}
                      className="btn"
                      data-testid="design-card-edit"
                    >
                      Edit design
                    </Link>
                    <DesignCardActions designId={item.id} />
                  </div>
                </div>
              </article>
            ))}
          </div>

          {list.totalPages > 1 && (
            <nav className="library-pagination" aria-label="Design pages">
              {list.page > 1 ? (
                <Link href={`/designs?page=${list.page - 1}`} className="btn btn--ghost">
                  Newer
                </Link>
              ) : (
                <span className="library-pagination__spacer" />
              )}
              <span className="library-pagination__info" data-testid="library-page-info">
                page {list.page} of {list.totalPages}
              </span>
              {list.page < list.totalPages ? (
                <Link href={`/designs?page=${list.page + 1}`} className="btn btn--ghost">
                  Older
                </Link>
              ) : (
                <span className="library-pagination__spacer" />
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
