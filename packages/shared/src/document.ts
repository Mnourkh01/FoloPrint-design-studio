import { BOUNDS_EPSILON, validateDesignObjects } from './geometry';
import type {
  AnyDesignDocument,
  DesignDocument,
  DesignPlacement,
  Rect,
} from './types';

/**
 * Normalizes any stored design document to the current version (v2).
 *
 * v1 documents ({ printAreaKey, objects }) become a single-placement v2 document.
 * v2 documents pass through unchanged. Anything else throws: an unknown version in
 * the database is data corruption, not user input, and must not be silently coerced.
 */
export function normalizeDesignDocument(raw: AnyDesignDocument): DesignDocument {
  if (raw.version === 2) {
    return raw;
  }
  if (raw.version === 1) {
    return {
      version: 2,
      templateId: raw.templateId,
      placements: [{ printAreaKey: raw.printAreaKey, objects: raw.objects }],
    };
  }
  throw new Error(
    `Unsupported design document version: ${String((raw as { version?: unknown }).version)}`,
  );
}

/** A print area as the placement validator needs it: rect + key + active flag. */
export interface ValidatablePrintArea extends Rect {
  key: string;
  /** Treated as true when omitted (pure-TS callers without an active concept). */
  active?: boolean;
}

export interface PlacementValidationError {
  /** Index into the placements array. */
  placementIndex: number;
  /** Index into that placement's objects array; absent for placement-level errors. */
  objectIndex?: number;
  message: string;
}

export interface PlacementValidationResult {
  valid: boolean;
  errors: PlacementValidationError[];
}

/**
 * Validates a v2 placements array against the template's print areas.
 *
 * Placement-level rules: at least one placement, no duplicate keys, every key must
 * match an existing AND active area, every placement needs at least one object.
 * Object-level rules: delegated to validateDesignObjects (finite, positive size,
 * rotated corners inside the placement's own area).
 *
 * Pure function: the editor uses it for UX, the API uses it as the authority.
 */
export function validateDesignPlacements(
  placements: Pick<DesignPlacement, 'printAreaKey' | 'objects'>[],
  printAreas: ValidatablePrintArea[],
  epsilon: number = BOUNDS_EPSILON,
): PlacementValidationResult {
  const errors: PlacementValidationError[] = [];

  if (placements.length === 0) {
    errors.push({ placementIndex: 0, message: 'Design must contain at least one placement' });
    return { valid: false, errors };
  }

  const areaByKey = new Map(printAreas.map((a) => [a.key, a]));
  const seenKeys = new Set<string>();

  placements.forEach((placement, placementIndex) => {
    const key = placement.printAreaKey;

    if (seenKeys.has(key)) {
      errors.push({ placementIndex, message: `Duplicate placement for print area "${key}"` });
      return;
    }
    seenKeys.add(key);

    const area = areaByKey.get(key);
    if (!area) {
      errors.push({ placementIndex, message: `Print area "${key}" does not exist` });
      return;
    }
    if (area.active === false) {
      errors.push({ placementIndex, message: `Print area "${key}" is not active` });
      return;
    }

    if (placement.objects.length === 0) {
      errors.push({
        placementIndex,
        message: `Placement for print area "${key}" has no objects`,
      });
      return;
    }

    const objectValidation = validateDesignObjects(placement.objects, area, epsilon);
    for (const objectError of objectValidation.errors) {
      errors.push({
        placementIndex,
        objectIndex: objectError.index,
        message: objectError.message,
      });
    }
  });

  return { valid: errors.length === 0, errors };
}
