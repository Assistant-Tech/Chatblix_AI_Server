import { Module } from '@nestjs/common';
import { InternalService } from './internal.service';
import { InternalController } from './internal.controller';

@Module({
  providers: [InternalService],
  controllers: [InternalController],
})
export class InternalModule {}
