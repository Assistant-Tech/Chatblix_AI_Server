import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatStreamService } from './chat-stream.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { HistoryModule } from '../history/history.module';

@Module({
  imports: [PipelineModule, HistoryModule],
  controllers: [ChatController],
  providers: [ChatStreamService],
})
export class ChatModule {}
