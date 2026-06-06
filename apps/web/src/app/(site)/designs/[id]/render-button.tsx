'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, renderDesign } from '@/lib/api';

export function RenderButton({ designId, hasPreviews }: { designId: string; hasPreviews: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await renderDesign(designId);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rendering failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className="btn btn--accent"
        style={{ width: 'auto', padding: '10px 22px' }}
        data-testid="render-again"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? 'Rendering...' : hasPreviews ? 'Render again' : 'Generate mockups'}
      </button>
      {error && (
        <p className="status status--error" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </div>
  );
}
