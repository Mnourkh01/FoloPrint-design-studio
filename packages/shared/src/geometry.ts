import type { DesignObject, Point, Rect } from './types';

/** Float tolerance for boundary checks (Fabric and float math produce sub-pixel noise). */
export const BOUNDS_EPSILON = 0.5;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * The four corners of a rotated rectangle defined by center (x, y), size, and rotation degrees.
 */
export function getRotatedCorners(obj: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}): Point[] {
  const rad = toRadians(obj.rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = obj.width / 2;
  const hh = obj.height / 2;

  const offsets: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];

  return offsets.map((o) => ({
    x: obj.x + o.x * cos - o.y * sin,
    y: obj.y + o.x * sin + o.y * cos,
  }));
}

/** Axis-aligned bounding box of a rotated object. */
export function getRotatedBoundingBox(obj: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}): Rect {
  const corners = getRotatedCorners(obj);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * True when every corner of the rotated object lies inside the rect (with epsilon tolerance).
 */
export function isObjectInsideRect(
  obj: { x: number; y: number; width: number; height: number; rotation: number },
  rect: Rect,
  epsilon: number = BOUNDS_EPSILON,
): boolean {
  if (obj.width <= 0 || obj.height <= 0) return false;
  return getRotatedCorners(obj).every(
    (c) =>
      c.x >= rect.x - epsilon &&
      c.x <= rect.x + rect.width + epsilon &&
      c.y >= rect.y - epsilon &&
      c.y <= rect.y + rect.height + epsilon,
  );
}

export interface DesignValidationError {
  /** Index into the objects array. */
  index: number;
  message: string;
}

export interface DesignValidationResult {
  valid: boolean;
  errors: DesignValidationError[];
}

/**
 * Validates that every design object is a sane, finite rectangle fully inside the print area.
 * Pure function: used by the editor for UX and by the API as the authority.
 */
export function validateDesignObjects(
  objects: Pick<DesignObject, 'x' | 'y' | 'width' | 'height' | 'rotation'>[],
  printArea: Rect,
  epsilon: number = BOUNDS_EPSILON,
): DesignValidationResult {
  const errors: DesignValidationError[] = [];

  objects.forEach((obj, index) => {
    const values = [obj.x, obj.y, obj.width, obj.height, obj.rotation];
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push({ index, message: 'Object has non-finite coordinates' });
      return;
    }
    if (obj.width <= 0 || obj.height <= 0) {
      errors.push({ index, message: 'Object width and height must be positive' });
      return;
    }
    if (!isObjectInsideRect(obj, printArea, epsilon)) {
      errors.push({ index, message: 'Object is outside the print area' });
    }
  });

  return { valid: errors.length === 0, errors };
}
