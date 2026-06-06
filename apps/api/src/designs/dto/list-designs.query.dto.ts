import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export const PAGE_DEFAULT = 1;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;

/**
 * Parses a query value into a clamped integer. Missing/empty values fall back to the
 * default; out-of-range integers clamp instead of erroring (a library page asking for
 * pageSize=500 should get the max, not a 400); anything non-integer passes through
 * untouched so @IsInt rejects it with a 400.
 */
const clampedInt =
  (fallback: number, min: number, max: number) =>
  ({ value }: { value: unknown }): unknown => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return value;
    return Math.min(Math.max(parsed, min), max);
  };

export class ListDesignsQueryDto {
  @Transform(clampedInt(PAGE_DEFAULT, 1, Number.MAX_SAFE_INTEGER))
  @IsInt()
  @Min(1)
  page: number = PAGE_DEFAULT;

  @Transform(clampedInt(PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX))
  @IsInt()
  @Min(1)
  @Max(PAGE_SIZE_MAX)
  pageSize: number = PAGE_SIZE_DEFAULT;
}
