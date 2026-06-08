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
  ARC_SWEEP_MAX,
  ARC_SWEEP_MIN,
  FONT_KEYS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  GARMENT_SIZES,
  HEX_COLOR_PATTERN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  PATTERN_SPACING_MAX,
  PATTERN_SPACING_MIN,
  PATTERN_TYPES,
  SHADOW_OFFSET_MAX,
  SHAPE_KINDS,
  SHAPE_STROKE_WIDTH_MAX,
  SHAPE_STROKE_WIDTH_MIN,
  TEXT_ALIGNMENTS,
  TEXT_DIRECTIONS,
  TEXT_MAX_LENGTH,
  TEXT_MAX_LINES,
  TEXT_WRAP_MODES,
  type GarmentSize,
  type PatternType,
  type ShapeKind,
  type TextAlign,
  type TextDirection,
  type TextWrapMode,
} from '@foloprint/shared';

/** v1.9 pattern tiling. Rotation-0 rule is enforced by the shared validation. */
export class ImagePatternDto {
  @IsIn(PATTERN_TYPES as readonly string[])
  type!: PatternType;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(PATTERN_SPACING_MIN)
  @Max(PATTERN_SPACING_MAX)
  spacing!: number;
}

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
const isShape = (o: DesignObjectDto): boolean => o.type === 'shape';
/** Image objects, including pre-v1.5 typeless payloads (assetId was the only kind). */
const isImage = (o: DesignObjectDto): boolean => o.type === 'image' || o.type === undefined;

/** v2.7 shape outline stroke. Both fields required when the object is present. */
export class ShapeStrokeDto {
  @Matches(HEX_COLOR_PATTERN, { message: 'stroke color must be a #RRGGBB hex value' })
  color!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(SHAPE_STROKE_WIDTH_MIN)
  @Max(SHAPE_STROKE_WIDTH_MAX)
  width!: number;
}

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
  @IsIn(['image', 'text', 'shape'])
  type?: 'image' | 'text' | 'shape';

  /** UploadedAsset id; required for image objects (and legacy typeless objects). */
  @ValidateIf(isImage)
  @IsUUID()
  assetId?: string;

  /** Tiling fill (v1.9); missing means the single image. Image objects only. */
  @ValidateIf(isImage)
  @IsOptional()
  @ValidateNested()
  @Type(() => ImagePatternDto)
  pattern?: ImagePatternDto;

  /** Vector silhouette (v2.7); required for shape objects. */
  @ValidateIf(isShape)
  @IsIn(SHAPE_KINDS as readonly string[])
  shape?: ShapeKind;

  /** Fill color #RRGGBB; required for shape objects. */
  @ValidateIf(isShape)
  @Matches(HEX_COLOR_PATTERN, { message: 'fill must be a #RRGGBB hex value' })
  fill?: string;

  /** Outline stroke (v2.7); missing means none. Shape objects only. */
  @ValidateIf(isShape)
  @IsOptional()
  @ValidateNested()
  @Type(() => ShapeStrokeDto)
  stroke?: ShapeStrokeDto;

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

  /** Extra space between glyphs, canvas px (v1.8); missing means font default. */
  @ValidateIf(isText)
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(LETTER_SPACING_MIN)
  @Max(LETTER_SPACING_MAX)
  letterSpacing?: number;

  /**
   * Arc sweep, degrees (v1.8); missing means straight. The non-zero rule and the
   * forbidden combinations (wrap, multi-line, RTL, outline, shadow) are enforced
   * by the shared validation the service runs as the authority.
   */
  @ValidateIf(isText)
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(ARC_SWEEP_MIN)
  @Max(ARC_SWEEP_MAX)
  arc?: number;
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

  /**
   * Chosen garment color (TemplateColor key, v2.0); missing means the template's
   * default color. Existence on the template is enforced in DesignsService.
   */
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'colorKey must be a lowercase kebab-case key',
  })
  colorKey?: string;

  /** Chosen garment size (v2.3); missing means no size picked. Whitelist-checked. */
  @IsOptional()
  @IsIn(GARMENT_SIZES as readonly string[])
  size?: GarmentSize;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => DesignPlacementDto)
  placements!: DesignPlacementDto[];
}
