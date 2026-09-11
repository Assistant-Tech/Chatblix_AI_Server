import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { DigestService } from './digest.service';

/**
 * Mirrors ReplyModule, minus BusinessModule: the digest needs no business
 * profile and no compiled system prompt, so it never touches the profile cache
 * or its main-backend HTTP fallback.
 */
@Module({
  imports: [PipelineModule],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}
