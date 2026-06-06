'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Canvas, FabricImage, Rect, type FabricObject } from 'fabric';
import {
  validateDesignObjects,
  type DesignObject,
  type DesignProjectDto,
  type ProductTemplateDto,
} from '@foloprint/shared';
import {
  ApiError,
  apiUrl,
  assetFileUrl,
  renderDesign,
  saveDesign,
  updateDesign,
  uploadAsset,
} from '@/lib/api';

const STAGE_WIDTH = 620;

type DesignedObject = FabricObject & { assetId?: string };

interface Status {
  tone: 'idle' | 'info' | 'error' | 'success';
  message: string;
  details?: string[];
}

interface SelectionReadout {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export function EditorClient({
  template,
  initialDesign,
}: {
  template: ProductTemplateDto;
  initialDesign?: DesignProjectDto;
}) {
  const router = useRouter();
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const printArea = template.printAreas[0];
  const zoom = STAGE_WIDTH / template.canvasWidth;
  const stageHeight = Math.round(template.canvasHeight * zoom);

  const [status, setStatus] = useState<Status>(
    initialDesign
      ? { tone: 'info', message: 'Editing saved design. Save your changes, then re-render the mockup.' }
      : { tone: 'idle', message: 'Upload artwork to get started.' },
  );
  const [objectCount, setObjectCount] = useState(0);
  const [selection, setSelection] = useState<SelectionReadout | null>(null);
  /** The persisted design being edited; null until the first successful save. */
  const [designId, setDesignId] = useState<string | null>(initialDesign?.id ?? null);
  /** True when the canvas differs from what the server has for designId. */
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'save' | 'render' | null>(null);

  const designedObjects = useCallback((): DesignedObject[] => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    return canvas.getObjects().filter((o): o is DesignedObject => Boolean((o as DesignedObject).assetId));
  }, []);

  /** Keep the object's bounding box inside the print area by translating it. */
  const clampToPrintArea = useCallback(
    (obj: FabricObject) => {
      if (!printArea) return;
      const box = obj.getBoundingRect();
      let dx = 0;
      let dy = 0;
      if (box.left < printArea.x) dx = printArea.x - box.left;
      if (box.top < printArea.y) dy = printArea.y - box.top;
      if (box.left + box.width > printArea.x + printArea.width) {
        dx = printArea.x + printArea.width - (box.left + box.width);
      }
      if (box.top + box.height > printArea.y + printArea.height) {
        dy = printArea.y + printArea.height - (box.top + box.height);
      }
      if (dx !== 0 || dy !== 0) {
        obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
        obj.setCoords();
      }
    },
    [printArea],
  );

  /** After scaling/rotating, shrink the object if its bounding box no longer fits, then clamp. */
  const fitToPrintArea = useCallback(
    (obj: FabricObject) => {
      if (!printArea) return;
      const box = obj.getBoundingRect();
      const factor = Math.min(printArea.width / box.width, printArea.height / box.height, 1);
      if (factor < 1) {
        obj.set({
          scaleX: (obj.scaleX ?? 1) * factor,
          scaleY: (obj.scaleY ?? 1) * factor,
        });
        obj.setCoords();
      }
      clampToPrintArea(obj);
    },
    [printArea, clampToPrintArea],
  );

  const readSelection = useCallback((obj: FabricObject | undefined | null) => {
    if (!obj || !(obj as DesignedObject).assetId) {
      setSelection(null);
      return;
    }
    setSelection({
      x: Math.round(obj.left ?? 0),
      y: Math.round(obj.top ?? 0),
      width: Math.round(obj.getScaledWidth()),
      height: Math.round(obj.getScaledHeight()),
      rotation: Math.round(obj.angle ?? 0),
    });
  }, []);

  const removeActiveObject = useCallback(() => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as DesignedObject | undefined;
    if (canvas && active?.assetId) {
      canvas.remove(active);
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      setSelection(null);
      setDirty(true);
      setObjectCount((c) => Math.max(0, c - 1));
    }
  }, []);

  useEffect(() => {
    const el = canvasElRef.current;
    if (!el || !printArea) return;

    const canvas = new Canvas(el, {
      width: STAGE_WIDTH,
      height: stageHeight,
      selection: false,
      preserveObjectStacking: true,
    });
    canvas.setZoom(zoom);
    canvasRef.current = canvas;
    // Exposed for the Playwright smoke test.
    (window as unknown as { __studioCanvas?: Canvas }).__studioCanvas = canvas;

    let disposed = false;

    FabricImage.fromURL(apiUrl(template.imageUrl), { crossOrigin: 'anonymous' })
      .then((img) => {
        if (disposed) return;
        img.set({
          scaleX: template.canvasWidth / (img.width ?? template.canvasWidth),
          scaleY: template.canvasHeight / (img.height ?? template.canvasHeight),
          originX: 'left',
          originY: 'top',
        });
        canvas.backgroundImage = img;
        canvas.requestRenderAll();
      })
      .catch(() => {
        setStatus({ tone: 'error', message: 'Could not load the template image.' });
      });

    if (template.overlayUrl) {
      FabricImage.fromURL(apiUrl(template.overlayUrl), { crossOrigin: 'anonymous' })
        .then((img) => {
          if (disposed) return;
          img.set({
            scaleX: template.canvasWidth / (img.width ?? template.canvasWidth),
            scaleY: template.canvasHeight / (img.height ?? template.canvasHeight),
            originX: 'left',
            originY: 'top',
          });
          canvas.overlayImage = img;
          canvas.requestRenderAll();
        })
        .catch(() => {
          /* overlay is decorative; ignore */
        });
    }

    const boundary = new Rect({
      left: printArea.x,
      top: printArea.y,
      width: printArea.width,
      height: printArea.height,
      originX: 'left',
      originY: 'top',
      fill: 'transparent',
      stroke: '#cf3f22',
      strokeDashArray: [6, 4],
      strokeWidth: 1.5,
      strokeUniform: true,
      selectable: false,
      evented: false,
    });
    canvas.add(boundary);

    // Re-open mode: place every saved object back exactly as persisted.
    if (initialDesign) {
      for (const saved of initialDesign.design.objects) {
        FabricImage.fromURL(apiUrl(assetFileUrl(saved.assetId)), { crossOrigin: 'anonymous' })
          .then((img) => {
            if (disposed) return;
            const naturalWidth = img.width ?? saved.width;
            const naturalHeight = img.height ?? saved.height;
            img.set({
              originX: 'center',
              originY: 'center',
              left: saved.x,
              top: saved.y,
              scaleX: saved.width / naturalWidth,
              scaleY: saved.height / naturalHeight,
              angle: saved.rotation,
            });
            (img as DesignedObject).assetId = saved.assetId;
            canvas.add(img);
            canvas.requestRenderAll();
            setObjectCount((c) => c + 1);
          })
          .catch(() => {
            setStatus({
              tone: 'error',
              message: 'Some saved artwork could not be loaded; it may have been removed.',
            });
          });
      }
    }

    const onMoving = (e: { target?: FabricObject }) => {
      if (e.target) clampToPrintArea(e.target);
    };
    const onModified = (e: { target?: FabricObject }) => {
      if (e.target) {
        fitToPrintArea(e.target);
        canvas.requestRenderAll();
        readSelection(e.target);
      }
      setDirty(true); // edits make the saved design (and its preview) stale
    };
    const onSelection = () => readSelection(canvas.getActiveObject());
    const onCleared = () => setSelection(null);

    canvas.on('object:moving', onMoving);
    canvas.on('object:modified', onModified);
    canvas.on('selection:created', onSelection);
    canvas.on('selection:updated', onSelection);
    canvas.on('selection:cleared', onCleared);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      removeActiveObject();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      void canvas.dispose();
      canvasRef.current = null;
    };
  }, [
    template,
    initialDesign,
    printArea,
    zoom,
    stageHeight,
    clampToPrintArea,
    fitToPrintArea,
    readSelection,
    removeActiveObject,
  ]);

  const handleUpload = async (file: File) => {
    const canvas = canvasRef.current;
    if (!canvas || !printArea) return;
    setBusy('upload');
    setStatus({ tone: 'info', message: `Uploading ${file.name}...` });
    try {
      const asset = await uploadAsset(file);
      const img = (await FabricImage.fromURL(apiUrl(asset.url), {
        crossOrigin: 'anonymous',
      })) as DesignedObject & FabricImage;

      const naturalWidth = img.width ?? 100;
      const naturalHeight = img.height ?? 100;
      const scale = Math.min(
        (printArea.width * 0.7) / naturalWidth,
        (printArea.height * 0.7) / naturalHeight,
      );
      img.set({
        originX: 'center',
        originY: 'center',
        left: printArea.x + printArea.width / 2,
        top: printArea.y + printArea.height / 2,
        scaleX: scale,
        scaleY: scale,
      });
      img.assetId = asset.id;
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      readSelection(img);
      setObjectCount((c) => c + 1);
      setDirty(true);
      setStatus({
        tone: 'success',
        message: `${asset.originalFilename} added. Drag, resize, and rotate it inside the print area.`,
      });
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Upload failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const collectObjects = useCallback((): DesignObject[] => {
    return designedObjects().map((obj) => ({
      assetId: obj.assetId as string,
      x: obj.left ?? 0,
      y: obj.top ?? 0,
      width: obj.getScaledWidth(),
      height: obj.getScaledHeight(),
      rotation: (obj.angle ?? 0) % 360,
    }));
  }, [designedObjects]);

  const handleSave = async () => {
    if (!printArea) return;
    const objects = collectObjects();
    if (objects.length === 0) {
      setStatus({ tone: 'error', message: 'Upload at least one artwork before saving.' });
      return;
    }

    const validation = validateDesignObjects(objects, printArea);
    if (!validation.valid) {
      setStatus({
        tone: 'error',
        message: 'Keep every object inside the print area.',
        details: validation.errors.map((e) => `Object ${e.index + 1}: ${e.message}`),
      });
      return;
    }

    setBusy('save');
    setStatus({ tone: 'info', message: designId ? 'Updating design...' : 'Saving design...' });
    try {
      const payload = { templateId: template.id, printAreaKey: printArea.key, objects };
      if (designId) {
        await updateDesign(designId, payload);
        setDirty(false);
        setStatus({
          tone: 'success',
          message: 'Design updated. The old preview is stale; render the mockup again.',
        });
      } else {
        const design = await saveDesign(payload);
        setDesignId(design.id);
        setDirty(false);
        setStatus({ tone: 'success', message: 'Design saved. Generate the mockup when ready.' });
      }
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Saving failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRender = async () => {
    if (!designId || dirty) return;
    setBusy('render');
    setStatus({ tone: 'info', message: 'Rendering mockup on the server...' });
    try {
      const result = await renderDesign(designId);
      router.push(`/designs/${result.id}`);
    } catch (error) {
      setBusy(null);
      setStatus({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Rendering failed.',
        details: error instanceof ApiError ? error.details : undefined,
      });
    }
  };

  const statusClass = useMemo(() => {
    if (status.tone === 'error') return 'status status--error';
    if (status.tone === 'success') return 'status status--success';
    return 'status';
  }, [status.tone]);

  if (!printArea) {
    return (
      <div className="notice">
        <strong>This template has no active print area.</strong>
        <p>Seed data is incomplete; re-run the seed.</p>
      </div>
    );
  }

  const saveLabel = busy === 'save'
    ? 'Saving...'
    : designId
      ? dirty
        ? 'Save changes'
        : 'Saved'
      : 'Save design';

  return (
    <div className="editor-grid">
      <div className="stage">
        <div
          className="stage__canvas-wrap"
          style={{ width: STAGE_WIDTH, height: stageHeight }}
          data-testid="editor-stage"
        >
          <canvas ref={canvasElRef} width={STAGE_WIDTH} height={stageHeight} />
        </div>
        <p className="stage__hint">
          The dashed <strong>red frame</strong> is the printable area. Artwork cannot be saved
          outside it.
        </p>
      </div>

      <aside className="rail">
        {designId && (
          <div className="badge" data-testid="editing-badge">
            Editing saved design · {designId.slice(0, 8)}
            {dirty ? ' · unsaved changes' : ''}
          </div>
        )}

        <section className="step">
          <div className="step__head">
            <span className="step__num">01</span>
            <span className="step__title">Artwork</span>
          </div>
          <p>PNG or JPEG, up to 10 MB. {objectCount} object{objectCount === 1 ? '' : 's'} placed.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            style={{ display: 'none' }}
            data-testid="upload-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="upload-button"
            disabled={busy !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy === 'upload' ? 'Uploading...' : 'Upload artwork'}
          </button>
        </section>

        <section className="step">
          <div className="step__head">
            <span className="step__num">02</span>
            <span className="step__title">Position</span>
          </div>
          {selection ? (
            <>
              <div className="readout" data-testid="selection-readout">
                <span>
                  center <b>{selection.x}, {selection.y}</b>
                </span>
                <span>
                  size <b>{selection.width} x {selection.height}</b>
                </span>
                <span>
                  angle <b>{selection.rotation}deg</b>
                </span>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                data-testid="delete-object"
                onClick={removeActiveObject}
              >
                Remove selected
              </button>
            </>
          ) : (
            <p>Select an object on the canvas to see its position. Drag corners to resize, the top handle to rotate.</p>
          )}
        </section>

        <section className="step">
          <div className="step__head">
            <span className="step__num">03</span>
            <span className="step__title">Save</span>
          </div>
          <p>Validated on the server against the print area.</p>
          <button
            type="button"
            className="btn"
            data-testid="save-design"
            disabled={busy !== null || objectCount === 0 || (designId !== null && !dirty)}
            onClick={() => void handleSave()}
          >
            {saveLabel}
          </button>
        </section>

        <section className="step">
          <div className="step__head">
            <span className="step__num">04</span>
            <span className="step__title">Mockup</span>
          </div>
          <p>
            {dirty && designId
              ? 'Unsaved changes. Save first, then render the fresh preview.'
              : 'Server-side render with sharp: base, your artwork, fabric overlay.'}
          </p>
          <button
            type="button"
            className="btn btn--accent"
            data-testid="generate-mockup"
            disabled={busy !== null || !designId || dirty}
            onClick={() => void handleRender()}
          >
            {busy === 'render' ? 'Rendering...' : 'Generate mockup'}
          </button>
        </section>

        <div className={statusClass} data-testid="editor-status" aria-live="polite">
          {status.message}
          {status.details && status.details.length > 0 && (
            <ul>
              {status.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
