import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Message } from '@prisma/client';

@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getRecentMessages(sessionId: string, limit = 10): Promise<Message[]> {
    const messages = await this.prisma.message.findMany({
      where: { session_id: sessionId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return messages.reverse();
  }

  async saveMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<Message> {
    return this.prisma.message.create({
      data: {
        session_id: sessionId,
        role,
        content,
        metadata: metadata ? (metadata as object) : undefined,
      },
    });
  }
}
