import { Module } from '@nestjs/common';
import { BusinessModule } from '../business/business.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SandboxController } from './sandbox.controller';
import { SandboxService } from './sandbox.service';

@Module({
  imports: [PipelineModule, BusinessModule],
  controllers: [SandboxController],
  providers: [SandboxService],
})
export class SandboxModule {}
