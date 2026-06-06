import { describe, expect, it } from 'vitest';
import {
  ASSUMED_PRINT_AREA_WIDTH_INCHES,
  collectQualityWarnings,
  evaluateObjectQuality,
  printAreaPpi,
  qualityLevelOf,
  worseQualityLevel,
} from './quality';
import type { PhysicalPrintArea } from './quality';

/** Seeded front area: 260x340 canvas px, 12 x 15.7 in. */
const frontArea: PhysicalPrintArea & { key: string } = {
  key: 'front',
  x: 370,
  y: 300,
  width: 260,
  height: 340,
  widthInches: 12,
  heightInches: 15.7,
};

const frontPpi = printAreaPpi(frontArea)!;

describe('printAreaPpi', () => {
  it('uses explicit physical inches per axis', () => {
    expect(frontPpi.x).toBeCloseTo(260 / 12, 10);
    expect(frontPpi.y).toBeCloseTo(340 / 15.7, 10);
  });

  it('assumes a 12in width when widthInches is null and derives height from aspect', () => {
    const ppi = printAreaPpi({ x: 0, y: 0, width: 260, height: 340 })!;
    expect(ppi.x).toBeCloseTo(260 / ASSUMED_PRINT_AREA_WIDTH_INCHES, 10);
    // Aspect-derived height keeps ppi uniform.
    expect(ppi.y).toBeCloseTo(ppi.x, 10);
  });

  it('derives height from the explicit width when only heightInches is null', () => {
    const ppi = printAreaPpi({ x: 0, y: 0, width: 200, height: 100, widthInches: 10 })!;
    expect(ppi.x).toBeCloseTo(20, 10);
    expect(ppi.y).toBeCloseTo(20, 10); // 100px / (10in * 100/200)
  });

  it('keeps per-axis scales when the physical aspect mismatches the canvas rect', () => {
    const ppi = printAreaPpi({ x: 0, y: 0, width: 200, height: 200, widthInches: 10, heightInches: 20 })!;
    expect(ppi.x).toBeCloseTo(20, 10);
    expect(ppi.y).toBeCloseTo(10, 10);
  });

  it('returns null for an unusable canvas rect', () => {
    expect(printAreaPpi({ x: 0, y: 0, width: 0, height: 340 })).toBeNull();
    expect(printAreaPpi({ x: 0, y: 0, width: 260, height: Number.NaN })).toBeNull();
  });

  it('falls back when physical inches are zero or negative', () => {
    const ppi = printAreaPpi({ x: 0, y: 0, width: 260, height: 340, widthInches: 0, heightInches: -5 })!;
    expect(ppi.x).toBeCloseTo(260 / ASSUMED_PRINT_AREA_WIDTH_INCHES, 10);
    expect(ppi.y).toBeCloseTo(ppi.x, 10);
  });
});

describe('qualityLevelOf', () => {
  it('puts boundary values on the better level', () => {
    expect(qualityLevelOf(150)).toBe('ok');
    expect(qualityLevelOf(149.9)).toBe('warning');
    expect(qualityLevelOf(100)).toBe('warning');
    expect(qualityLevelOf(99.9)).toBe('poor');
  });
});

describe('evaluateObjectQuality', () => {
  // Default 70% drop on the front area: 182x182 canvas px -> 8.4in wide.
  const placed = { width: 182, height: 182 };

  it('matches the worked examples from the plan', () => {
    const hi = evaluateObjectQuality({ width: 2000, height: 2000 }, placed, frontPpi)!;
    // Y axis ppi (340/15.7) is marginally below X (260/12); min picks it: ~238.
    expect(hi.effectiveDpi).toBeCloseTo((2000 * (340 / 15.7)) / 182, 5);
    expect(Math.round(hi.effectiveDpi)).toBe(238);
    expect(hi.level).toBe('ok');

    const mid = evaluateObjectQuality({ width: 1000, height: 1000 }, placed, frontPpi)!;
    expect(Math.round(mid.effectiveDpi)).toBe(119);
    expect(mid.level).toBe('warning');

    const low = evaluateObjectQuality({ width: 400, height: 400 }, placed, frontPpi)!;
    expect(Math.round(low.effectiveDpi)).toBe(48);
    expect(low.level).toBe('poor');

    const tiny = evaluateObjectQuality({ width: 64, height: 64 }, placed, frontPpi)!;
    expect(tiny.effectiveDpi).toBeLessThan(10);
    expect(tiny.level).toBe('poor');
  });

  it('takes the worse axis on non-uniform placement', () => {
    // Square source stretched wide: X axis is the stretched (worse) one.
    const quality = evaluateObjectQuality(
      { width: 1000, height: 1000 },
      { width: 260, height: 100 },
      frontPpi,
    )!;
    expect(quality.dpiX).toBeLessThan(quality.dpiY);
    expect(quality.effectiveDpi).toBeCloseTo(quality.dpiX, 10);
  });

  it('is independent of rotation by construction (no rotation input exists)', () => {
    // Same object placed at any angle yields the same numbers because the
    // function only consumes width/height. This test documents the contract.
    const a = evaluateObjectQuality({ width: 500, height: 500 }, { width: 182, height: 182 }, frontPpi)!;
    const b = evaluateObjectQuality({ width: 500, height: 500 }, { width: 182, height: 182 }, frontPpi)!;
    expect(a).toEqual(b);
  });

  it('returns null on unknown or unusable inputs', () => {
    expect(evaluateObjectQuality({ width: null, height: 500 }, placed, frontPpi)).toBeNull();
    expect(evaluateObjectQuality({ width: 500, height: undefined }, placed, frontPpi)).toBeNull();
    expect(evaluateObjectQuality({ width: 500, height: 500 }, { width: 0, height: 182 }, frontPpi)).toBeNull();
    expect(
      evaluateObjectQuality({ width: 500, height: 500 }, { width: Number.NaN, height: 182 }, frontPpi),
    ).toBeNull();
    expect(evaluateObjectQuality({ width: 500, height: 500 }, placed, null)).toBeNull();
  });
});

describe('collectQualityWarnings', () => {
  const backArea: PhysicalPrintArea & { key: string } = {
    key: 'back',
    x: 370,
    y: 260,
    width: 260,
    height: 380,
    widthInches: 12,
    heightInches: 17.5,
  };

  const assetDims = new Map<string, { width: number | null; height: number | null }>([
    ['hi-res', { width: 4000, height: 4000 }],
    ['low-res', { width: 64, height: 64 }],
    ['no-dims', { width: null, height: null }],
  ]);

  const object = (assetId: string) => ({ assetId, x: 500, y: 470, width: 182, height: 182, rotation: 0 });

  it('reports warnings only, with correct placement key and object index', () => {
    const warnings = collectQualityWarnings(
      [
        { printAreaKey: 'front', objects: [object('hi-res'), object('low-res')] },
        { printAreaKey: 'back', objects: [object('low-res')] },
      ],
      [frontArea, backArea],
      assetDims,
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      printAreaKey: 'front',
      objectIndex: 1,
      assetId: 'low-res',
      level: 'poor',
    });
    expect(warnings[0].effectiveDpi).toBeGreaterThan(0);
    expect(Number.isInteger(warnings[0].effectiveDpi)).toBe(true);
    expect(warnings[1]).toMatchObject({ printAreaKey: 'back', objectIndex: 0, level: 'poor' });
  });

  it('stays silent for unknown assets, missing dims, and unknown areas', () => {
    const warnings = collectQualityWarnings(
      [
        { printAreaKey: 'front', objects: [object('no-dims'), object('not-in-map')] },
        { printAreaKey: 'ghost-area', objects: [object('low-res')] },
      ],
      [frontArea],
      assetDims,
    );
    expect(warnings).toEqual([]);
  });

  it('rotation value in the document has no effect on the result', () => {
    const rotated = { ...object('low-res'), rotation: 137 };
    const flat = object('low-res');
    const [a] = collectQualityWarnings([{ printAreaKey: 'front', objects: [rotated] }], [frontArea], assetDims);
    const [b] = collectQualityWarnings([{ printAreaKey: 'front', objects: [flat] }], [frontArea], assetDims);
    expect(a.effectiveDpi).toBe(b.effectiveDpi);
    expect(a.level).toBe(b.level);
  });
});

describe('worseQualityLevel', () => {
  it('ranks poor > warning > ok', () => {
    expect(worseQualityLevel('ok', 'warning')).toBe('warning');
    expect(worseQualityLevel('poor', 'warning')).toBe('poor');
    expect(worseQualityLevel('ok', 'ok')).toBe('ok');
    expect(worseQualityLevel('warning', 'poor')).toBe('poor');
  });
});
