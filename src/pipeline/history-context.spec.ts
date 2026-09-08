import { compactHistory } from './history-context';
import type { IncomingHistoryMessage } from '../common/types/pipeline.types';

describe('compactHistory', () => {
  it('keeps only role and content, dropping timestamp and metadata', () => {
    const history: IncomingHistoryMessage[] = [
      {
        role: 'user',
        content: 'hi',
        timestamp: '2026-06-28T00:00:00Z',
        metadata: { extracted_data: { name: 'Ram' }, lead_score: 40 },
      },
      { role: 'assistant', content: 'Hajur, namaste!', timestamp: '2026-06-28T00:00:01Z' },
    ];
    expect(compactHistory(history)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hajur, namaste!' },
    ]);
  });

  it('returns [] for null/undefined/non-array', () => {
    expect(compactHistory(null)).toEqual([]);
    expect(compactHistory(undefined)).toEqual([]);
    expect(compactHistory('nope' as any)).toEqual([]);
  });

  it('is materially smaller than the raw JSON when metadata is present', () => {
    const history: IncomingHistoryMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
      timestamp: '2026-06-28T00:00:00.000Z',
      metadata: { extracted_data: { name: 'Ram', phone: '98XXXXXXXX', address: 'KTM' }, lead_score: 50 },
    }));
    const raw = JSON.stringify(history).length;
    const compact = JSON.stringify(compactHistory(history)).length;
    expect(compact).toBeLessThan(raw);
  });
});
