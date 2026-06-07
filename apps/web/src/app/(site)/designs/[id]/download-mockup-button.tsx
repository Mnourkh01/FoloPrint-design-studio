'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';

/**
 * The download formats a user actually needs for re-uploading a mockup
 * elsewhere. PNG is the safe default (lossless, keeps transparency, accepted
 * everywhere). JPEG is the smallest and the universal choice for marketplace
 * listings (flattened onto white). WebP is the modern small-but-sharp option.
 * `mime` is the canvas encoder type; PNG bypasses re-encoding entirely.
 */
const FORMATS = [
  { key: 'png', label: 'PNG', ext: 'png', mime: 'image/png', hint: 'Lossless, transparent. Best quality.' },
  { key: 'jpg', label: 'JPG', ext: 'jpg', mime: 'image/jpeg', hint: 'Smallest. Best for listings.' },
  { key: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', hint: 'Modern, small, sharp.' },
] as const;

type FormatKey = (typeof FORMATS)[number]['key'];

/** JPEG/WebP quality; high enough that a mockup preview shows no artifacts. */
const ENCODE_QUALITY = 0.92;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Re-encodes a source PNG blob to another image type via a canvas. JPEG has no
 * alpha, so the garment is flattened onto white first (otherwise transparent
 * pixels render black). Returns the original blob untouched for PNG.
 */
async function toFormat(source: Blob, mime: string): Promise<Blob> {
  if (mime === 'image/png') return source;

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);

    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, ENCODE_QUALITY),
    );
    // Some browsers return null for an unsupported type (e.g. older Safari + WebP).
    if (!out) throw new Error(`This browser cannot export ${mime}`);
    return out;
  } finally {
    bitmap.close();
  }
}

/**
 * Downloads one rendered mockup in a chosen format. The preview endpoint serves
 * the PNG inline for the <img>, so a cross-origin `download` link is ignored;
 * fetching the blob client-side (CORS allows GET) lets us re-encode and name the
 * file. Mockups are decorative previews, not the print file: the name says so.
 */
export function DownloadMockupButton({
  previewUrl,
  designId,
  areaKey,
  cacheBust,
}: {
  previewUrl: string;
  designId: string;
  areaKey: string;
  cacheBust: string;
}) {
  const [format, setFormat] = useState<FormatKey>('png');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = FORMATS.find((f) => f.key === format)!;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl(previewUrl)}?t=${cacheBust}`);
      if (!res.ok) throw new Error(`Could not load the mockup (${res.status}).`);
      const png = await res.blob();
      const out = await toFormat(png, spec.mime);
      saveBlob(out, `mockup-${designId.slice(0, 8)}-${areaKey}.${spec.ext}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mockup-download">
      <div className="mockup-download__row">
        <label className="mockup-download__format">
          <span className="visually-hidden">Download format</span>
          <select
            value={format}
            disabled={busy}
            data-testid={`mockup-format-${areaKey}`}
            onChange={(e) => setFormat(e.target.value as FormatKey)}
          >
            {FORMATS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="preview-frame__download"
          data-testid={`download-mockup-${areaKey}`}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? 'Preparing...' : `Download ${spec.label}`}
        </button>
      </div>
      <p className="mockup-download__hint">{error ?? spec.hint}</p>
    </div>
  );
}
