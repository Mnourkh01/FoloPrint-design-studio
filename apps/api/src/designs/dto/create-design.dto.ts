import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  FONT_KEYS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  HEX_COLOR_PATTERN,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  SHADOW_OFFSET_MAX,
  TEXT_ALIGNMENTS,
  TEXT_DIRECTIONS,
  TEXT_MAX_LENGTH,
  TEXT_MAX_LINES,
  TEXT_WRAP_MODES,
  type TextAlign,
  type TextDirection,
  type TextWrapMode,
} from '@foloprint/shared';

/** v1.8 glyph outline. Both fields required when the object is present. */
export class TextOutlineDto {
  @Matches(HEX_COLOR_PATTERN, { message: 'outline color must be a #RRGGBB hex value' })
  color!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(OUTLINE_WIDTH_MIN)
  @Max(OUTLINE_WIDTH_MAX)
  width!: number;
}

/** v1.8 hard drop shadow. All fields required when the object is present. */
export class TextShadowDto {
  @Matches(HEX_COLOR_PATTERN, { message: 'shadow color must be a #RRGGBB hex value' })
  color!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-SHADOW_OFFSET_MAX)
  @Max(SHADOW_OFFSET_MAX)
  offsetX!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-SHADOW_OFFSET_MAX)
  @Max(SHADOW_OFFSET_MAX)
  offsetY!: number;
}

const isText = (o: DesignObjectDto): boolean => o.type === 'text';

/**
 * One design object: an image (assetId) or a text element, discriminated on `type`.
 * A missing `type` means image, so pre-v1.5 clients keep working unchanged.
 *
 * One class with conditional validators instead of class-transformer subtype
 * discrimination: simpler to debug, and kind purity (text never carries assetId,
 * image never carries text fields) is enforced by the shared validation the
 * service runs as the authority (designObjectContentErrors).
 *
 * Line count, control characters, and cross-field rules are also covered by that
 * shared validation; this DTO rejects the cheap structural failures early.
 */
export class DesignObjectDto {
  @IsOptional()
  @IsIn(['image', 'text'])
  type?: 'image' | 'text';

  /** UploadedAsset id; required for image objects (and legacy typeless objects). */
  @ValidateIf((o: DesignObjectDto) => !isText(o))
  @IsUUID()
  assetId?: string;

  /** Object center X, template canvas px. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  x!: number;

  /** Object center Y, template canvas px. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  y!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  width!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  height!: number;

  /** Degrees clockwise around the object center. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-360)
  @Max(360)
  rotation!: number;

  /** Plain text, `\n` for explicit line breaks. Text objects only. */
  @ValidateIf(isText)
  @IsString()
  @Length(1, TEXT_MAX_LENGTH)
  text?: string;

  /** Whitelist font key. Text objects only. */
  @ValidateIf(isText)
  @IsIn(FONT_KEYS as string[])
  fontFamily?: string;

  /** Font size in canvas px. Text objects only. */
  @ValidateIf(isText)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(FONT_SIZE_MIN)
  @Max(FONT_SIZE_MAX)
  fontSize?: number;

  /** #RRGGBB. Text objects only. */
  @ValidateIf(isText)
  @Matches(HEX_COLOR_PATTERN, { message: 'color must be a #RRGGBB hex value' })
  color?: string;

  @ValidateIf(isText)
  @IsIn(TEXT_ALIGNMENTS as readonly string[])
  align?: TextAlign;

  /** Base direction; missing means 'auto'. Text objects only. */
  @ValidateIf(isText)
  @IsOptional()
  @IsIn(TEXT_DIRECTIONS as readonly string[])
  direction?: TextDirection;

  /** Wrap behavior; missing means 'none'. Text objects only. */
  @ValidateIf(isText)
  @IsOptional()
  @IsIn(TEXT_WRAP_MODES as readonly string[])
  wrapMode?: TextWrapMode;

  /**
   * Editor-derived visual lines; required with wrapMode 'box', forbidden otherwise.
   * Presence pairing, per-entry content, and reconciliation against `text` are
   * enforced by the shared validation the service runs as the authority.
   */
  @ValidateIf(isText)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEXT_MAX_LINES)
  @IsString({ each: true })
  @Length(1, TEXT_MAX_LENGTH, { each: true })
  wrappedLines?: string[];

  /** Glyph outline (v1.8); missing means none. Text objects only. */
  @ValidateIf(isText)
  @IsOptional()
  @ValidateNested()
  @Type(() => TextOutlineDto)
  outline?: TextOutlineDto;

  /** Hard drop shadow (v1.8); missing means none. Text objects only. */
  @ValidateIf(isText)
  @IsOptional()
  @ValidateNested()
  @Type(() => TextShadowDto)
  shadow?: TextShadowDto;
}

/** All artwork for one print area. Placements with zero objects are rejected. */
export class DesignPlacementDto {
  @IsString()
  @Length(1, 50)
  printAreaKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DesignObjectDto)
  objects!: DesignObjectDto[];
}

/**
 * Design document v2 write shape. Duplicate/unknown/inactive print area keys,
 * per-area geometry, and object content rules (including kind purity) are enforced
 * in DesignsService against the live template via the shared validators.
 */
export class CreateDesignDto {
  @IsUUID()
  templateId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => DesignPlacementDto)
  placements!: DesignPlacementDto[];
}
