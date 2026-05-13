import { Module } from '@nestjs/common';
import { HistoryService } from './history.service';
import { LeadService } from './lead.service';

@Module({
  providers: [HistoryService, LeadService],
  exports: [HistoryService, LeadService],
})
export class HistoryModule {}
