import { describe, expect, it } from 'vitest';
import {
  getRotatedCorners,
  getRotatedBoundingBox,
  isObjectInsideRect,
  validateDesignObjects,
} from './geometry';
import type { Rect } from './types';

const printArea: Rect = { x: 100, y: 100, width: 400, height: 300 };

describe('getRotatedCorners', () => {
  it('returns axis-aligned corners for zero rotation', () => {
    const corners = getRotatedCorners({ x: 200, y: 200, width: 100, height: 50, rotation: 0 });
    expect(corners).toEqual([
      { x: 150, y: 175 },
      { x: 250, y: 175 },
      { x: 250, y: 225 },
      { x: 150, y: 225 },
    ]);
  });

  it('swaps extents at 90 degrees', () => {
    const box = getRotatedBoundingBox({ x: 0, y: 0, width: 100, height: 50, rotation: 90 });
    expect(box.width).toBeCloseTo(50, 5);
    expect(box.height).toBeCloseTo(100, 5);
  });
});

describe('isObjectInsideRect', () => {
  it('accepts an object fully inside', () => {
    expect(
      isObjectInsideRect({ x: 300, y: 250, width: 100, height: 80, rotation: 0 }, printArea),
    ).toBe(true);
  });

  it('accepts an object exactly on the boundary', () => {
    // 200-wide object centered at x=200 -> left edge exactly at 100
    expect(
      isObjectInsideRect({ x: 200, y: 250, width: 200, height: 100, rotation: 0 }, printArea),
    ).toBe(true);
  });

  it('rejects an object crossing the left edge', () => {
    expect(
      isObjectInsideRect({ x: 120, y: 250, width: 100, height: 80, rotation: 0 }, printArea),
    ).toBe(false);
  });

  it('rejects an unrotated-fitting object once rotation pushes a corner out', () => {
    // Fits axis-aligned against the top edge, but rotating 45deg pushes corners out
    const snug = { x: 300, y: 150, width: 380, height: 90, rotation: 0 };
    expect(isObjectInsideRect(snug, printArea)).toBe(true);
    expect(isObjectInsideRect({ ...snug, rotation: 45 }, printArea)).toBe(false);
  });

  it('accepts a rotated object whose corners all stay inside', () => {
    expect(
      isObjectInsideRect({ x: 300, y: 250, width: 120, height: 120, rotation: 30 }, printArea),
    ).toBe(true);
  });

  it('rejects zero or negative dimensions', () => {
    expect(
      isObjectInsideRect({ x: 300, y: 250, width: 0, height: 80, rotation: 0 }, printArea),
    ).toBe(false);
  });
});

describe('validateDesignObjects', () => {
  it('passes a valid design', () => {
    const result = validateDesignObjects(
      [
        { x: 300, y: 250, width: 100, height: 80, rotation: 15 },
        { x: 200, y: 200, width: 50, height: 50, rotation: 0 },
      ],
      printArea,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports the index of an out-of-area object', () => {
    const result = validateDesignObjects(
      [
        { x: 300, y: 250, width: 100, height: 80, rotation: 0 },
        { x: 600, y: 250, width: 100, height: 80, rotation: 0 },
      ],
      printArea,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ index: 1, message: 'Object is outside the print area' }]);
  });

  it('rejects non-finite coordinates', () => {
    const result = validateDesignObjects(
      [{ x: Number.NaN, y: 250, width: 100, height: 80, rotation: 0 }],
      printArea,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/non-finite/);
  });

  it('rejects non-positive dimensions', () => {
    const result = validateDesignObjects(
      [{ x: 300, y: 250, width: -5, height: 80, rotation: 0 }],
      printArea,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/positive/);
  });
});
