import { inferPriorAgentQuestion } from './reply.service';
import type { IncomingHistoryMessage } from '../common/types/pipeline.types';

const h = (role: 'user' | 'assistant', content: string): IncomingHistoryMessage =>
  ({ role, content } as IncomingHistoryMessage);

describe('inferPriorAgentQuestion — never returns an already-answered question (W8)', () => {
  it('returns the assistant question when it is the last turn (unanswered)', () => {
    const history = [h('user', 'hi'), h('assistant', 'What size do you want?')];
    expect(inferPriorAgentQuestion(history)).toBe('What size do you want?');
  });

  it('returns null when the customer already replied after the question', () => {
    const history = [
      h('assistant', 'What size do you want?'),
      h('user', 'large please'),
    ];
    expect(inferPriorAgentQuestion(history)).toBeNull();
  });

  it('returns null when the most recent assistant turn was not a question', () => {
    const history = [h('user', 'hi'), h('assistant', 'Sure, here you go.')];
    expect(inferPriorAgentQuestion(history)).toBeNull();
  });

  it('does not resurface an older answered question when a newer non-question turn exists', () => {
    const history = [
      h('assistant', 'What is your budget?'),
      h('user', '5000'),
      h('assistant', 'Great, noted.'),
    ];
    expect(inferPriorAgentQuestion(history)).toBeNull();
  });

  it('returns null on empty history', () => {
    expect(inferPriorAgentQuestion([])).toBeNull();
  });
});
