'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Canvas, FabricImage, Rect, type FabricObject } from 'fabric';
import {
  validateDesignPlacements,
  type DesignObject,
  type DesignPlacement,
  type DesignProjectDto,
  type PrintAreaDto,
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

/**
 * Every artwork object on the canvas is tagged with the print area it belongs to.
 * Inactive-area objects stay on the canvas but are hidden and non-interactive; they
 * are still serialized on save (one Fabric canvas, no per-area canvas churn).
 */
type DesignedObject = FabricObject & { assetId?: string; printAreaKey?: string };

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
  const boundaryRef = useRef<Rect | null>(null);
  /** Loaded view images per area key ('' = template-level), so tab switches don't re-fetch. */
  const baseCacheRef = useRef(new Map<string, FabricImage>());
  const overlayCacheRef = useRef(new Map<string, FabricImage>());

  const zoom = STAGE_WIDTH / template.canvasWidth;
  const stageHeight = Math.round(template.canvasHeight * zoom);

  const [activeAreaKey, setActiveAreaKey] = useState<string>(
    () =>
      initialDesign?.design.placements[0]?.printAreaKey ??
      template.printAreas[0]?.key ??
      '',
  );
  /** Mirrors activeAreaKey for canvas event handlers registered once at init. */
  const activeAreaKeyRef = useRef(activeAreaKey);
  activeAreaKeyRef.current = activeAreaKey;

  /** Bumped once the canvas exists so area-dependent effects can run. */
  const [canvasReady, setCanvasReady] = useState(false);

  const [status, setStatus] = useState<Status>(
    initialDesign
      ? { tone: 'info', message: 'Editing saved design. Save your changes, then re-render the mockups.' }
      : { tone: 'idle', message: 'Upload artwork to get started.' },
  );
  /** Object count per print area key, for the tab badges and the save guard. */
  const [areaCounts, setAreaCounts] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<SelectionReadout | null>(null);
  /** The persisted design being edited; null until the first successful save. */
  const [designId, setDesignId] = useState<string | null>(initialDesign?.id ?? null);
  /** True when ANY area differs from what the server has for designId (dirty is global). */
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'save' | 'render' | null>(null);

  const activeArea = useMemo(
    () => template.printAreas.find((a) => a.key === activeAreaKey),
    [template.printAreas, activeAreaKey],
  );

  const designedObjects = useCallback((): DesignedObject[] => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    return canvas.getObjects().filter((o): o is DesignedObject => Boolean((o as DesignedObject).assetId));
  }, []);

  const refreshAreaCounts = useCallback(() => {
    const counts: Record<string, number> = {};
    for (const obj of designedObjects()) {
      if (obj.printAreaKey) counts[obj.printAreaKey] = (counts[obj.printAreaKey] ?? 0) + 1;
    }
    setAreaCounts(counts);
  }, [designedObjects]);

  /** The print area an object belongs to; falls back to the active one. */
  const areaOf = useCallback(
    (obj: DesignedObject): PrintAreaDto | undefined =>
      template.printAreas.find((a) => a.key === (obj.printAreaKey ?? activeAreaKeyRef.current)),
    [template.printAreas],
  );

  /** Keep the object's bounding box inside ITS OWN print area by translating it. */
  const clampToPrintArea = useCallback(
    (obj: DesignedObject) => {
      const area = areaOf(obj);
      if (!area) return;
      const box = obj.getBoundingRect();
      let dx = 0;
      let dy = 0;
      if (box.left < area.x) dx = area.x - box.left;
      if (box.top < area.y) dy = area.y - box.top;
      if (box.left + box.width > area.x + area.width) {
        dx = area.x + area.width - (box.left + box.width);
      }
      if (box.top + box.height > area.y + area.height) {
        dy = area.y + area.height - (box.top + box.height);
      }
      if (dx !== 0 || dy !== 0) {
        obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
        obj.setCoords();
      }
    },
    [areaOf],
  );

  /** After scaling/rotating, shrink the object if its box no longer fits its area, then clamp. */
  const fitToPrintArea = useCallback(
    (obj: DesignedObject) => {
      const area = areaOf(obj);
      if (!area) return;
      const box = obj.getBoundingRect();
      const factor = Math.min(area.width / box.width, area.height / box.height, 1);
      if (factor < 1) {
        obj.set({
          scaleX: (obj.scaleX ?? 1) * factor,
          scaleY: (obj.scaleY ?? 1) * factor,
        });
        obj.setCoords();
      }
      clampToPrintArea(obj);
    },
    [areaOf, clampToPrintArea],
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
      refreshAreaCounts();
    }
  }, [refreshAreaCounts]);

  /** Loads a view image (base or overlay) into the per-area cache. */
  const loadViewImage = useCallback(
    async (cache: Map<string, FabricImage>, cacheKey: string, url: string): Promise<FabricImage> => {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const img = await FabricImage.fromURL(apiUrl(url), { crossOrigin: 'anonymous' });
      img.set({
        scaleX: template.canvasWidth / (img.width ?? template.canvasWidth),
        scaleY: template.canvasHeight / (img.height ?? template.canvasHeight),
        originX: 'left',
        originY: 'top',
      });
      cache.set(cacheKey, img);
      return img;
    },
    [template.canvasWidth, template.canvasHeight],
  );

  // ---- canvas init: create once per template/design ----
  useEffect(() => {
    const el = canvasElRef.current;
    if (!el || template.printAreas.length === 0) return;

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

    const boundary = new Rect({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
      originX: 'left',
      originY: 'top',
      fill: 'transparent',
      stroke: '#cf3f22',
      strokeDashArray: [6, 4],
      strokeWidth: 1.5,
      strokeUniform: true,
      selectable: false,
      evented: false,
      visible: false, // positioned by the area effect before first paint
    });
    canvas.add(boundary);
    boundaryRef.current = boundary;

    // Re-open mode: place every saved object of every placement back exactly as persisted.
    if (initialDesign) {
      for (const placement of initialDesign.design.placements) {
        for (const saved of placement.objects) {
          FabricImage.fromURL(apiUrl(assetFileUrl(saved.assetId)), { crossOrigin: 'anonymous' })
            .then((img) => {
              if (disposed) return;
              const naturalWidth = img.width ?? saved.width;
              const naturalHeight = img.height ?? saved.height;
              const mine = placement.printAreaKey === activeAreaKeyRef.current;
              img.set({
                originX: 'center',
                originY: 'center',
                left: saved.x,
                top: saved.y,
                scaleX: saved.width / naturalWidth,
                scaleY: saved.height / naturalHeight,
                angle: saved.rotation,
                visible: mine,
                evented: mine,
                selectable: mine,
              });
              const designed = img as DesignedObject;
              designed.assetId = saved.assetId;
              designed.printAreaKey = placement.printAreaKey;
              canvas.add(img);
              canvas.requestRenderAll();
              refreshAreaCounts();
            })
            .catch(() => {
              setStatus({
                tone: 'error',
                message: 'Some saved artwork could not be loaded; it may have been removed.',
              });
            });
        }
      }
    }

    const onMoving = (e: { target?: FabricObject }) => {
      if (e.target) clampToPrintArea(e.target as DesignedObject);
    };
    const onModified = (e: { target?: FabricObject }) => {
      if (e.target) {
        fitToPrintArea(e.target as DesignedObject);
        canvas.requestRenderAll();
        readSelection(e.target);
      }
      setDirty(true); // edits make the saved design (and its previews) stale
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

    setCanvasReady(true);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      setCanvasReady(false);
      baseCacheRef.current.clear();
      overlayCacheRef.current.clear();
      boundaryRef.current = null;
      void canvas.dispose();
      canvasRef.current = null;
    };
  }, [
    template,
    initialDesign,
    zoom,
    stageHeight,
    clampToPrintArea,
    fitToPrintArea,
    readSelection,
    removeActiveObject,
    refreshAreaCounts,
  ]);

  // ---- area switch: swap view images + boundary, toggle object visibility ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const boundary = boundaryRef.current;
    const area = template.printAreas.find((a) => a.key === activeAreaKey);
    if (!canvasReady || !canvas || !boundary || !area) return;

    let cancelled = false;

    // Boundary follows the active area.
    boundary.set({ left: area.x, top: area.y, width: area.width, height: area.height, visible: true });
    boundary.setCoords();

    // Only the active area's objects are visible and interactive. Hidden objects keep
    // their geometry untouched; save serializes them from the same canvas.
    for (const obj of designedObjects()) {
      const mine = obj.printAreaKey === area.key;
      obj.set({ visible: mine, evented: mine, selectable: mine });
    }
    canvas.discardActiveObject();
    setSelection(null);
    canvas.requestRenderAll();

    // View images: the area's own base/overlay, falling back to the template's.
    const baseUrl = area.imageUrl ?? template.imageUrl;
    const baseCacheKey = area.imageUrl ? area.key : '';
    loadViewImage(baseCacheRef.current, baseCacheKey, baseUrl)
      .then((img) => {
        if (cancelled) return;
        canvas.backgroundImage = img;
        canvas.requestRenderAll();
      })
      .catch(() => {
        if (!cancelled) setStatus({ tone: 'error', message: 'Could not load the template image.' });
      });

    const overlayUrl = area.overlayUrl ?? template.overlayUrl;
    if (overlayUrl) {
      const overlayCacheKey = area.overlayUrl ? area.key : '';
      loadViewImage(overlayCacheRef.current, overlayCacheKey, overlayUrl)
        .then((img) => {
          if (cancelled) return;
          canvas.overlayImage = img;
          canvas.requestRenderAll();
        })
        .catch(() => {
          /* overlay is decorative; ignore */
        });
    } else {
      canvas.overlayImage = undefined;
      canvas.requestRenderAll();
    }

    return () => {
      cancelled = true;
    };
  }, [canvasReady, activeAreaKey, template, designedObjects, loadViewImage]);

  const handleUpload = async (file: File) => {
    const canvas = canvasRef.current;
    const area = activeArea;
    if (!canvas || !area) return;
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
        (area.width * 0.7) / naturalWidth,
        (area.height * 0.7) / naturalHeight,
      );
      img.set({
        originX: 'center',
        originY: 'center',
        left: area.x + area.width / 2,
        top: area.y + area.height / 2,
        scaleX: scale,
        scaleY: scale,
      });
      img.assetId = asset.id;
      img.printAreaKey = area.key;
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      readSelection(img);
      refreshAreaCounts();
      setDirty(true);
      setStatus({
        tone: 'success',
        message: `${asset.originalFilename} added to ${area.name}. Drag, resize, and rotate it inside the print area.`,
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

  /**
   * Serializes ALL areas (visible and hidden) from the one canvas into v2 placements.
   * Normalized fields only; never raw Fabric JSON. Areas with no objects are omitted.
   */
  const collectPlacements = useCallback((): DesignPlacement[] => {
    const byArea = new Map<string, DesignObject[]>();
    for (const obj of designedObjects()) {
      if (!obj.assetId || !obj.printAreaKey) continue;
      const list = byArea.get(obj.printAreaKey) ?? [];
      list.push({
        assetId: obj.assetId,
        x: obj.left ?? 0,
        y: obj.top ?? 0,
        width: obj.getScaledWidth(),
        height: obj.getScaledHeight(),
        rotation: (obj.angle ?? 0) % 360,
      });
      byArea.set(obj.printAreaKey, list);
    }
    // Stable order: template area order, not canvas stacking order.
    return template.printAreas
      .filter((a) => byArea.has(a.key))
      .map((a) => ({ printAreaKey: a.key, objects: byArea.get(a.key)! }));
  }, [designedObjects, template.printAreas]);

  const areaName = useCallback(
    (key: string) => template.printAreas.find((a) => a.key === key)?.name ?? key,
    [template.printAreas],
  );

  const handleSave = async () => {
    const placements = collectPlacements();
    if (placements.length === 0) {
      setStatus({ tone: 'error', message: 'Upload at least one artwork before saving.' });
      return;
    }

    const validation = validateDesignPlacements(placements, template.printAreas);
    if (!validation.valid) {
      setStatus({
        tone: 'error',
        message: 'Keep every object inside its print area.',
        details: validation.errors.map((e) => {
          const key = placements[e.placementIndex]?.printAreaKey ?? '?';
          const objectPart = e.objectIndex !== undefined ? `, object ${e.objectIndex + 1}` : '';
          return `${areaName(key)}${objectPart}: ${e.message}`;
        }),
      });
      return;
    }

    setBusy('save');
    setStatus({ tone: 'info', message: designId ? 'Updating design...' : 'Saving design...' });
    try {
      const payload = { templateId: template.id, placements };
      if (designId) {
        await updateDesign(designId, payload);
        setDirty(false);
        setStatus({
          tone: 'success',
          message: 'Design updated. The old previews are stale; render the mockups again.',
        });
      } else {
        const design = await saveDesign(payload);
        setDesignId(design.id);
        setDirty(false);
        setStatus({ tone: 'success', message: 'Design saved. Generate the mockups when ready.' });
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
    setStatus({ tone: 'info', message: 'Rendering mockups on the server...' });
    try {
      const result = await renderDesign(designId);
      router.push(`/designs/${result.designId}`);
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

  if (template.printAreas.length === 0) {
    return (
      <div className="notice">
        <strong>This template has no active print area.</strong>
        <p>Seed data is incomplete; re-run the seed.</p>
      </div>
    );
  }

  const totalObjects = Object.values(areaCounts).reduce((sum, n) => sum + n, 0);
  const placedAreas = Object.keys(areaCounts).length;

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
        <div className="area-tabs" role="tablist" aria-label="Print areas">
          {template.printAreas.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-selected={a.key === activeAreaKey}
              className={a.key === activeAreaKey ? 'area-tab area-tab--active' : 'area-tab'}
              data-testid={`area-tab-${a.key}`}
              onClick={() => setActiveAreaKey(a.key)}
            >
              {a.name}
              {areaCounts[a.key] ? <span className="area-tab__count">{areaCounts[a.key]}</span> : null}
            </button>
          ))}
        </div>
        <div
          className="stage__canvas-wrap"
          style={{ width: STAGE_WIDTH, height: stageHeight }}
          data-testid="editor-stage"
        >
          <canvas ref={canvasElRef} width={STAGE_WIDTH} height={stageHeight} />
        </div>
        <p className="stage__hint">
          The dashed <strong>red frame</strong> is the printable area for{' '}
          {activeArea?.name ?? 'this side'}. Artwork cannot be saved outside it.
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
          <p>
            PNG or JPEG, up to 10 MB. Uploads land on <b>{activeArea?.name ?? 'the active side'}</b>.{' '}
            {totalObjects} object{totalObjects === 1 ? '' : 's'} across {placedAreas || 'no'} area
            {placedAreas === 1 ? '' : 's'}.
          </p>
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
          <p>Front and back save together as one design, validated on the server per print area.</p>
          <button
            type="button"
            className="btn"
            data-testid="save-design"
            disabled={busy !== null || totalObjects === 0 || (designId !== null && !dirty)}
            onClick={() => void handleSave()}
          >
            {saveLabel}
          </button>
        </section>

        <section className="step">
          <div className="step__head">
            <span className="step__num">04</span>
            <span className="step__title">Mockups</span>
          </div>
          <p>
            {dirty && designId
              ? 'Unsaved changes. Save first, then render the fresh previews.'
              : 'Server-side render with sharp: one mockup for every side that has artwork.'}
          </p>
          <button
            type="button"
            className="btn btn--accent"
            data-testid="generate-mockup"
            disabled={busy !== null || !designId || dirty}
            onClick={() => void handleRender()}
          >
            {busy === 'render' ? 'Rendering...' : 'Generate mockups'}
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
