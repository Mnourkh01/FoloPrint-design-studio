import { describe, expect, it } from 'vitest';
import { normalizeDesignObject, validateDesignPlacements } from './document';
import {
  STAR_INNER_RATIO,
  STAR_POINTS,
  starPolygonPoints,
} from './shapes';
import {
  designObjectContentErrors,
  SHAPE_STROKE_WIDTH_MAX,
  SHAPE_STROKE_WIDTH_MIN,
} from './text';
import type { ShapeDesignObject, StoredDesignObject } from './types';

const validShape = (overrides: Partial<ShapeDesignObject> = {}): ShapeDesignObject => ({
  type: 'shape',
  shape: 'rect',
  fill: '#cf3f22',
  x: 200,
  y: 200,
  width: 120,
  height: 80,
  rotation: 0,
  ...overrides,
});

const errorsOf = (overrides: Partial<ShapeDesignObject>): string[] =>
  designObjectContentErrors(validShape(overrides));

describe('starPolygonPoints', () => {
  it('returns two vertices per point (outer + inner)', () => {
    expect(starPolygonPoints(100, 100)).toHaveLength(STAR_POINTS * 2);
    expect(starPolygonPoints(100, 100, 6)).toHaveLength(12);
  });

  it('places the first outer vertex at top-center and fills the box', () => {
    const pts = starPolygonPoints(100, 60);
    // First outer vertex points straight up: centered x, top edge y.
    expect(pts[0]!.x).toBeCloseTo(50, 5);
    expect(pts[0]!.y).toBeCloseTo(0, 5);
    // Outer vertices ride the box; nothing escapes [0,w] x [0,h].
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(100 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeLessThanOrEqual(60 + 1e-9);
    }
  });

  it('inner vertices sit at the inner ratio of the outer radius', () => {
    const pts = starPolygonPoints(200, 200);
    const cx = 100;
    const cy = 100;
    const outer = Math.hypot(pts[0]!.x - cx, pts[0]!.y - cy);
    const inner = Math.hypot(pts[1]!.x - cx, pts[1]!.y - cy);
    expect(inner / outer).toBeCloseTo(STAR_INNER_RATIO, 5);
  });

  it('is deterministic (editor and renderer must agree)', () => {
    expect(starPolygonPoints(120, 80)).toEqual(starPolygonPoints(120, 80));
  });
});

describe('normalizeDesignObject for shapes', () => {
  it('passes a typed shape through unchanged', () => {
    const shape = validShape({ stroke: { color: '#000000', width: 4 } });
    expect(normalizeDesignObject(shape as StoredDesignObject)).toEqual(shape);
  });
});

describe('designObjectContentErrors for shapes', () => {
  it('accepts a valid rect, circle, and star', () => {
    expect(errorsOf({ shape: 'rect' })).toEqual([]);
    expect(errorsOf({ shape: 'circle' })).toEqual([]);
    expect(errorsOf({ shape: 'star' })).toEqual([]);
  });

  it('accepts a valid stroke and rejects out-of-range widths', () => {
    expect(errorsOf({ stroke: { color: '#ffffff', width: SHAPE_STROKE_WIDTH_MIN } })).toEqual([]);
    expect(errorsOf({ stroke: { color: '#ffffff', width: SHAPE_STROKE_WIDTH_MAX } })).toEqual([]);
    expect(errorsOf({ stroke: { color: '#ffffff', width: SHAPE_STROKE_WIDTH_MAX + 1 } })).not.toEqual(
      [],
    );
    expect(errorsOf({ stroke: { color: 'white', width: 4 } })).toContain(
      'Shape stroke color must be a #RRGGBB hex value',
    );
  });

  it('rejects an unknown silhouette', () => {
    expect(errorsOf({ shape: 'triangle' as ShapeDesignObject['shape'] })).toContain(
      'Shape must be one of rect, circle, star',
    );
  });

  it('rejects a non-hex fill', () => {
    expect(errorsOf({ fill: 'red' })).toContain('Shape fill must be a #RRGGBB hex value');
    expect(errorsOf({ fill: '#abc' })).toContain('Shape fill must be a #RRGGBB hex value');
  });

  it('enforces kind purity: a shape carries no image or text fields', () => {
    const withAsset = { ...validShape(), assetId: 'x' } as unknown as StoredDesignObject;
    expect(designObjectContentErrors(withAsset)).toContain('Shape object must not carry image fields');
    const withText = { ...validShape(), text: 'hi', fontFamily: 'inter' } as unknown as StoredDesignObject;
    expect(designObjectContentErrors(withText)).toContain('Shape object must not carry text fields');
  });

  it('rejects shape fields smuggled onto image or text objects', () => {
    const image = {
      type: 'image',
      assetId: '11111111-1111-1111-1111-111111111111',
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      rotation: 0,
      fill: '#000000',
    } as unknown as StoredDesignObject;
    expect(designObjectContentErrors(image)).toContain('Image object must not carry shape fields');

    const text = {
      type: 'text',
      text: 'hi',
      fontFamily: 'inter',
      fontSize: 48,
      color: '#000000',
      align: 'center',
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      rotation: 0,
      shape: 'star',
    } as unknown as StoredDesignObject;
    expect(designObjectContentErrors(text)).toContain('Text object must not carry shape fields');
  });
});

describe('validateDesignPlacements with shapes', () => {
  const area = { key: 'front', x: 0, y: 0, width: 400, height: 400 };

  it('accepts a shape fully inside the print area', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [validShape()] }],
      [area],
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a shape whose rotated box leaves the print area', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [validShape({ x: 380, width: 120 })] }],
      [area],
    );
    expect(result.valid).toBe(false);
  });
});
