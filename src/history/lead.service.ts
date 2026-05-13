import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Lead, Prisma } from '@prisma/client';
import type { AgentMetadata } from '../common/types/pipeline.types';

const STAGE_RANK: Record<string, number> = { cold: 0, warm: 1, hot: 2, closing: 3, won: 4 };

@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateLead(sessionId: string): Promise<Lead> {
    let lead = await this.prisma.lead.findUnique({ where: { id: sessionId } });
    if (!lead) {
      lead = await this.prisma.lead.create({ data: { id: sessionId } });
    }
    return lead;
  }

  async getLead(sessionId: string): Promise<Lead | null> {
    return this.prisma.lead.findUnique({ where: { id: sessionId } });
  }

  async updateLeadState(sessionId: string, metadata: AgentMetadata | null): Promise<Lead | undefined> {
    if (!metadata) return;

    const lead = await this.getOrCreateLead(sessionId);

    const existingData =
      typeof lead.extracted_data === 'string'
        ? (JSON.parse(lead.extracted_data) as Record<string, unknown>)
        : ((lead.extracted_data as Record<string, unknown>) || {});

    const newData = metadata.extracted_data || {};

    const mergedExtractedData: Record<string, unknown> = { ...existingData };
    for (const [key, value] of Object.entries(newData)) {
      if (
        value !== null &&
        value !== undefined &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0)
      ) {
        mergedExtractedData[key] = value;
      }
    }

    let nextStage = metadata.stage || lead.stage;
    if (metadata.stage && metadata.stage !== 'lost') {
      const newRank = STAGE_RANK[metadata.stage] ?? -1;
      const oldRank = STAGE_RANK[lead.stage] ?? -1;
      if (newRank < oldRank) nextStage = lead.stage;
    }

    return this.prisma.lead.update({
      where: { id: sessionId },
      data: {
        lead_score:
          metadata.lead_score !== undefined
            ? Math.max(lead.lead_score, Number(metadata.lead_score))
            : lead.lead_score,
        stage: nextStage,
        last_intent: metadata.intent || lead.last_intent,
        extracted_data: mergedExtractedData as Prisma.InputJsonValue,
      },
    });
  }
}
