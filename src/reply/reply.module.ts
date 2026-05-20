import { Module } from '@nestjs/common';
import { BusinessModule } from '../business/business.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ContextLoaderService } from './context-loader.service';
import { ReplyService } from './reply.service';

@Module({
  imports: [BusinessModule, PipelineModule],
  providers: [ContextLoaderService, ReplyService],
  exports: [ReplyService],
})
export class ReplyModule {}
