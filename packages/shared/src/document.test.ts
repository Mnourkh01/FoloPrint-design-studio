import { describe, expect, it } from 'vitest';
import { normalizeDesignDocument, validateDesignPlacements } from './document';
import type {
  AnyDesignDocument,
  DesignDocumentV1,
  DesignObject,
  StoredDesignObject,
  TextDesignObject,
} from './types';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

const FRONT = { key: 'front', x: 100, y: 100, width: 200, height: 200, active: true };
const BACK = { key: 'back', x: 400, y: 100, width: 200, height: 250, active: true };
const SLEEVE_INACTIVE = { key: 'sleeve', x: 700, y: 100, width: 80, height: 80, active: false };
const AREAS = [FRONT, BACK, SLEEVE_INACTIVE];

const centeredObject = (area: { x: number; y: number; width: number; height: number }): DesignObject => ({
  type: 'image',
  assetId: ASSET_ID,
  x: area.x + area.width / 2,
  y: area.y + area.height / 2,
  width: 50,
  height: 50,
  rotation: 0,
});

/** A pre-v1.5 stored object: image shape without the type discriminator. */
const legacyObject = (area: { x: number; y: number; width: number; height: number }): StoredDesignObject => ({
  assetId: ASSET_ID,
  x: area.x + area.width / 2,
  y: area.y + area.height / 2,
  width: 50,
  height: 50,
  rotation: 0,
});

const textObject = (
  area: { x: number; y: number; width: number; height: number },
  overrides: Partial<TextDesignObject> = {},
): TextDesignObject => ({
  type: 'text',
  text: 'Hello',
  fontFamily: 'inter',
  fontSize: 40,
  color: '#1a1a1a',
  align: 'center',
  x: area.x + area.width / 2,
  y: area.y + area.height / 2,
  width: 80,
  height: 40,
  rotation: 0,
  ...overrides,
});

describe('normalizeDesignDocument', () => {
  it('upgrades a v1 document to a single-placement v2 document with typed objects', () => {
    const v1: DesignDocumentV1 = {
      version: 1,
      templateId: TEMPLATE_ID,
      printAreaKey: 'front',
      objects: [legacyObject(FRONT)],
    };

    const normalized = normalizeDesignDocument(v1);

    expect(normalized.version).toBe(2);
    expect(normalized.templateId).toBe(TEMPLATE_ID);
    expect(normalized.placements).toHaveLength(1);
    expect(normalized.placements[0]?.printAreaKey).toBe('front');
    expect(normalized.placements[0]?.objects).toEqual([{ type: 'image', ...legacyObject(FRONT) }]);
  });

  it('adds the image type to legacy v2 objects and defaults text direction/wrap', () => {
    const v2 = {
      version: 2 as const,
      templateId: TEMPLATE_ID,
      placements: [
        { printAreaKey: 'front', objects: [legacyObject(FRONT)] },
        { printAreaKey: 'back', objects: [centeredObject(BACK), textObject(BACK, { y: BACK.y + 40 })] },
      ],
    };

    const normalized = normalizeDesignDocument(v2);

    expect(normalized.placements[0]?.objects).toEqual([{ type: 'image', ...legacyObject(FRONT) }]);
    // Images pass through untouched; pre-v1.6 text objects gain the additive defaults.
    expect(normalized.placements[1]?.objects).toEqual([
      v2.placements[1]!.objects[0],
      { ...v2.placements[1]!.objects[1], direction: 'auto', wrapMode: 'none' },
    ]);
  });

  it('keeps explicit text direction/wrapMode/wrappedLines on normalize', () => {
    const wrapped = textObject(BACK, {
      text: 'Hello world',
      direction: 'rtl',
      wrapMode: 'box',
      wrappedLines: ['Hello', 'world'],
    });
    const normalized = normalizeDesignDocument({
      version: 2,
      templateId: TEMPLATE_ID,
      placements: [{ printAreaKey: 'back', objects: [wrapped] }],
    });
    expect(normalized.placements[0]?.objects[0]).toEqual(wrapped);
  });

  it('throws on an unknown document version', () => {
    const bogus = { version: 99, templateId: TEMPLATE_ID } as unknown as AnyDesignDocument;
    expect(() => normalizeDesignDocument(bogus)).toThrow(/Unsupported design document version: 99/);
  });

  it('passes colorKey through on v2 and never invents one when absent', () => {
    const base = {
      version: 2 as const,
      templateId: TEMPLATE_ID,
      placements: [{ printAreaKey: 'front', objects: [centeredObject(FRONT)] }],
    };

    expect(normalizeDesignDocument({ ...base, colorKey: 'black' }).colorKey).toBe('black');
    // Absent stays absent: pre-v2.0 documents must persist byte-identical.
    expect('colorKey' in normalizeDesignDocument(base)).toBe(false);
  });
});

describe('validateDesignPlacements', () => {
  it('accepts front and back placements with objects inside their own areas', () => {
    const result = validateDesignPlacements(
      [
        { printAreaKey: 'front', objects: [centeredObject(FRONT)] },
        { printAreaKey: 'back', objects: [centeredObject(BACK)] },
      ],
      AREAS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty placements array', () => {
    const result = validateDesignPlacements([], AREAS);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/at least one placement/);
  });

  it('rejects duplicate print area keys', () => {
    const result = validateDesignPlacements(
      [
        { printAreaKey: 'front', objects: [centeredObject(FRONT)] },
        { printAreaKey: 'front', objects: [centeredObject(FRONT)] },
      ],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { placementIndex: 1, message: 'Duplicate placement for print area "front"' },
    ]);
  });

  it('rejects an unknown print area key', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'pocket', objects: [centeredObject(FRONT)] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/"pocket" does not exist/);
  });

  it('rejects an inactive print area', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'sleeve', objects: [centeredObject(SLEEVE_INACTIVE)] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/"sleeve" is not active/);
  });

  it('treats a missing active flag as active', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [centeredObject(FRONT)] }],
      [{ key: 'front', x: FRONT.x, y: FRONT.y, width: FRONT.width, height: FRONT.height }],
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a placement with no objects', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/has no objects/);
  });

  it('validates each object against its own placement area, not another area', () => {
    // Object centered on FRONT but declared under BACK: must fail for back.
    const result = validateDesignPlacements(
      [{ printAreaKey: 'back', objects: [centeredObject(FRONT)] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { placementIndex: 0, objectIndex: 0, message: 'Object is outside the print area' },
    ]);
  });

  it('preserves rotated-corner validation per area', () => {
    // Fills the back area exactly; any rotation pushes corners out.
    const fillingObject: DesignObject = {
      type: 'image',
      assetId: ASSET_ID,
      x: BACK.x + BACK.width / 2,
      y: BACK.y + BACK.height / 2,
      width: BACK.width,
      height: BACK.height,
      rotation: 45,
    };
    const result = validateDesignPlacements(
      [{ printAreaKey: 'back', objects: [fillingObject] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.objectIndex).toBe(0);
    expect(result.errors[0]?.message).toMatch(/outside the print area/);

    // Same object unrotated fits.
    const unrotated = validateDesignPlacements(
      [{ printAreaKey: 'back', objects: [{ ...fillingObject, rotation: 0 }] }],
      AREAS,
    );
    expect(unrotated.valid).toBe(true);
  });

  it('reports the correct placement index for a failing object in a multi-area design', () => {
    const outsideBack: DesignObject = {
      type: 'image',
      assetId: ASSET_ID,
      x: BACK.x + BACK.width + 500,
      y: BACK.y,
      width: 40,
      height: 40,
      rotation: 0,
    };
    const result = validateDesignPlacements(
      [
        { printAreaKey: 'front', objects: [centeredObject(FRONT)] },
        { printAreaKey: 'back', objects: [centeredObject(BACK), outsideBack] },
      ],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { placementIndex: 1, objectIndex: 1, message: 'Object is outside the print area' },
    ]);
  });
});

describe('validateDesignPlacements with text objects', () => {
  it('accepts a valid text object and a mixed image+text placement', () => {
    const result = validateDesignPlacements(
      [
        { printAreaKey: 'front', objects: [centeredObject(FRONT), textObject(FRONT, { y: FRONT.y + 50 })] },
        { printAreaKey: 'back', objects: [textObject(BACK)] },
      ],
      AREAS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts legacy objects without a type (treated as images)', () => {
    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [legacyObject(FRONT)] }],
      AREAS,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a text object outside its print area, including via rotation', () => {
    const outside = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [textObject(FRONT, { x: FRONT.x + FRONT.width + 100 })] }],
      AREAS,
    );
    expect(outside.valid).toBe(false);
    expect(outside.errors[0]?.message).toMatch(/outside the print area/);

    // Fills the front area exactly; rotation pushes corners out.
    const rotated = validateDesignPlacements(
      [
        {
          printAreaKey: 'front',
          objects: [
            textObject(FRONT, { width: FRONT.width, height: FRONT.height, rotation: 30 }),
          ],
        },
      ],
      AREAS,
    );
    expect(rotated.valid).toBe(false);
    expect(rotated.errors[0]?.message).toMatch(/outside the print area/);
  });

  it('reports content errors with placement and object indexes', () => {
    const result = validateDesignPlacements(
      [
        {
          printAreaKey: 'front',
          objects: [
            centeredObject(FRONT),
            textObject(FRONT, { fontFamily: 'comic-sans', color: 'red' }),
          ],
        },
      ],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ placementIndex: 0, objectIndex: 1, message: expect.stringMatching(/font whitelist/) }),
      expect.objectContaining({ placementIndex: 0, objectIndex: 1, message: expect.stringMatching(/#RRGGBB/) }),
    ]);
  });

  it('rejects kind-mixed objects (text with assetId, image with text fields)', () => {
    const textWithAsset = {
      ...textObject(FRONT),
      assetId: ASSET_ID,
    } as unknown as StoredDesignObject;
    const imageWithText = {
      ...centeredObject(FRONT),
      text: 'sneaky',
    } as unknown as StoredDesignObject;

    const result = validateDesignPlacements(
      [{ printAreaKey: 'front', objects: [textWithAsset, imageWithText] }],
      AREAS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual([
      'Text object must not carry an assetId',
      'Image object must not carry text fields',
    ]);
  });
});
