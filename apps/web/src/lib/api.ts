import type {
  DesignDocument,
  DesignListDto,
  DesignProjectDto,
  ProductTemplateDto,
  RenderResultDto,
  UploadedAssetDto,
} from '@foloprint/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Prefix a relative API path (the API only ever returns relative URLs). */
export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T;
  }
  let message = `Request failed (${res.status})`;
  let details: string[] = [];
  try {
    const body = (await res.json()) as { message?: string | string[]; errors?: string[] };
    if (Array.isArray(body.message)) {
      message = body.message[0] ?? message;
      details = body.message;
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
    if (Array.isArray(body.errors)) {
      details = body.errors;
    }
  } catch {
    // non-JSON error body; keep the generic message
  }
  throw new ApiError(res.status, message, details);
}

export async function fetchTemplates(): Promise<ProductTemplateDto[]> {
  return handle(await fetch(apiUrl('/templates'), { cache: 'no-store' }));
}

export async function fetchTemplate(slug: string): Promise<ProductTemplateDto> {
  return handle(await fetch(apiUrl(`/templates/${encodeURIComponent(slug)}`), { cache: 'no-store' }));
}

export async function uploadAsset(file: File): Promise<UploadedAssetDto> {
  const form = new FormData();
  form.append('file', file);
  return handle(await fetch(apiUrl('/assets/upload'), { method: 'POST', body: form }));
}

/** Derives a new asset with the flat background removed; the source asset stays intact. */
export async function removeAssetBackground(assetId: string): Promise<UploadedAssetDto> {
  return handle(
    await fetch(apiUrl(`/assets/${encodeURIComponent(assetId)}/remove-background`), {
      method: 'POST',
    }),
  );
}

/** Derives a new asset cropped to the given source-pixel rect; the source stays intact. */
export async function cropAsset(
  assetId: string,
  rect: { left: number; top: number; width: number; height: number },
): Promise<UploadedAssetDto> {
  return handle(
    await fetch(apiUrl(`/assets/${encodeURIComponent(assetId)}/crop`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rect),
    }),
  );
}

export interface SaveDesignPayload {
  templateId: string;
  /** Chosen garment color key (v2.0); omitted = the template's default color. */
  colorKey?: string;
  placements: DesignDocument['placements'];
}

export async function saveDesign(payload: SaveDesignPayload): Promise<DesignProjectDto> {
  return handle(
    await fetch(apiUrl('/designs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/** Replaces the design document of an existing design; the server clears ALL stale area previews. */
export async function updateDesign(id: string, payload: SaveDesignPayload): Promise<DesignProjectDto> {
  return handle(
    await fetch(apiUrl(`/designs/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/** Stable asset file URL (relative); the API never exposes storage paths. */
export function assetFileUrl(assetId: string): string {
  return `/assets/${assetId}/file`;
}

/** Bundled whitelist font file URL (relative); same binary the server renders with. */
export function fontFileUrl(fontKey: string): string {
  return `/fonts/${encodeURIComponent(fontKey)}/file`;
}

export async function fetchDesign(id: string): Promise<DesignProjectDto> {
  return handle(await fetch(apiUrl(`/designs/${encodeURIComponent(id)}`), { cache: 'no-store' }));
}

/** Paginated design library; the server clamps page/pageSize and echoes effective values. */
export async function fetchDesigns(page = 1): Promise<DesignListDto> {
  return handle(await fetch(apiUrl(`/designs?page=${page}`), { cache: 'no-store' }));
}

export async function renderDesign(id: string): Promise<RenderResultDto> {
  return handle(await fetch(apiUrl(`/designs/${encodeURIComponent(id)}/render`), { method: 'POST' }));
}

/** Deletes a design and its rendered previews. Resolves on 204; throws ApiError otherwise. */
export async function deleteDesign(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/designs/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!res.ok) {
    await handle(res); // throws with the server's message
  }
}

/** Duplicates a design (same template + document, no previews); returns the copy. */
export async function duplicateDesign(id: string): Promise<DesignProjectDto> {
  return handle(
    await fetch(apiUrl(`/designs/${encodeURIComponent(id)}/duplicate`), { method: 'POST' }),
  );
}
