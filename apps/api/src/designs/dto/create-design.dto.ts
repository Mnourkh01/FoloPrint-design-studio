import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class DesignObjectDto {
  @IsUUID()
  assetId!: string;

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
 * Design document v2 write shape. Duplicate/unknown/inactive print area keys and
 * per-area geometry are enforced in DesignsService against the live template.
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
