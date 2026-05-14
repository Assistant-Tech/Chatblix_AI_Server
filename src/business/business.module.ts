import { Module } from '@nestjs/common';
import { BusinessProfileService } from './business-profile.service';
import { SystemPromptCompilerService } from './system-prompt-compiler.service';
import { BusinessesController } from './businesses.controller';

@Module({
  providers: [BusinessProfileService, SystemPromptCompilerService],
  controllers: [BusinessesController],
  exports: [BusinessProfileService, SystemPromptCompilerService],
})
export class BusinessModule {}
