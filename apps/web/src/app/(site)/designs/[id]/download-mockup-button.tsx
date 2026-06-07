'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';

/**
 * Downloads one rendered mockup PNG. The preview endpoint serves the image
 * inline for the <img> tag, so a plain `download` link is ignored cross-origin;
 * fetching the blob and saving it client-side works (CORS already allows GET)
 * and lets us name the file. Mockups are decorative previews, not the print
 * file: the filename says so.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const download = async () => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`${apiUrl(previewUrl)}?t=${cacheBust}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mockup-${designId.slice(0, 8)}-${areaKey}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="preview-frame__download"
      data-testid={`download-mockup-${areaKey}`}
      disabled={busy}
      onClick={() => void download()}
    >
      {busy ? 'Preparing...' : error ? 'Retry download' : 'Download mockup'}
    </button>
  );
}
