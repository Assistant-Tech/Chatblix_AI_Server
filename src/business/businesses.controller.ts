import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { BusinessProfileDto } from '../common/types/business-profile.dto';
import { BusinessProfileService, UpsertResult } from './business-profile.service';

@ApiTags('businesses')
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly profiles: BusinessProfileService) {}

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upsert a business profile (called by main backend on tenant save).',
    description:
      'Stores the full BusinessProfile JSON, bumps version, and invalidates the cached compiled prompt and profile cache for this business.',
  })
  @ApiParam({ name: 'id', description: 'Business id from the main backend' })
  @ApiResponse({ status: 200, description: '{ id, version, updated_at }' })
  @ApiResponse({ status: 401, description: 'Missing or invalid INTERNAL_API_TOKEN' })
  @ApiResponse({ status: 422, description: 'Malformed BusinessProfile body' })
  async upsert(
    @Param('id') id: string,
    @Body() dto: BusinessProfileDto,
  ): Promise<UpsertResult> {
    return this.profiles.upsert(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete a business profile (called by main backend on tenant offboard).',
    description:
      'Sets active=false. Subsequent /reply requests for this business return 404. Invalidates caches.',
  })
  @ApiParam({ name: 'id', description: 'Business id from the main backend' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid INTERNAL_API_TOKEN' })
  @ApiResponse({ status: 404, description: 'Unknown business id' })
  async delete(@Param('id') id: string): Promise<void> {
    await this.profiles.softDelete(id);
  }
}
