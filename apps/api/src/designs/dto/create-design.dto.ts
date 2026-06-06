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

export class CreateDesignDto {
  @IsUUID()
  templateId!: string;

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
