'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, deleteDesign, duplicateDesign } from '@/lib/api';

/**
 * Duplicate / delete controls on one library card. Client island inside the
 * server-rendered library page; both actions refresh the route so the list
 * re-reads from the API (the copy appears, the deleted row disappears).
 */
export function DesignCardActions({ designId }: { designId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'delete' | 'duplicate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'delete' | 'duplicate') => {
    if (action === 'delete' && !window.confirm('Delete this design? Its mockups go with it.')) {
      return;
    }
    setBusy(action);
    setError(null);
    try {
      if (action === 'delete') {
        await deleteDesign(designId);
      } else {
        await duplicateDesign(designId);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="design-card__manage">
      <button
        type="button"
        className="design-card__manage-btn"
        data-testid="design-card-duplicate"
        disabled={busy !== null}
        onClick={() => void run('duplicate')}
      >
        {busy === 'duplicate' ? 'Duplicating...' : 'Duplicate'}
      </button>
      <button
        type="button"
        className="design-card__manage-btn design-card__manage-btn--danger"
        data-testid="design-card-delete"
        disabled={busy !== null}
        onClick={() => void run('delete')}
      >
        {busy === 'delete' ? 'Deleting...' : 'Delete'}
      </button>
      {error && <span className="design-card__manage-error">{error}</span>}
    </span>
  );
}
