import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalTokenGuard } from './internal-token.guard';

@Global()
@Module({
  providers: [
    InternalTokenGuard,
    { provide: APP_GUARD, useClass: InternalTokenGuard },
  ],
  exports: [InternalTokenGuard],
})
export class AuthModule {}
