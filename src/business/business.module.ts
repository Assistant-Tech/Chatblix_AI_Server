import { Module } from '@nestjs/common';
import { BusinessProfileService } from './business-profile.service';
import { SystemPromptCompilerService } from './system-prompt-compiler.service';
import { MainBackendClient } from '../common/clients/main-backend.client';

@Module({
  providers: [BusinessProfileService, SystemPromptCompilerService, MainBackendClient],
  exports: [BusinessProfileService, SystemPromptCompilerService],
})
export class BusinessModule {}
