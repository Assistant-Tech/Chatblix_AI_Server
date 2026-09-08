import { ResponseCleanerService } from './response-cleaner.service';

describe('ResponseCleanerService.normalizeTypography', () => {
  const svc = new ResponseCleanerService();

  it('replaces em-dashes and en-dashes with plain hyphens', () => {
    expect(svc.normalizeTypography('What brings you in today — looking for skin care?')).toBe(
      'What brings you in today - looking for skin care?',
    );
    expect(svc.normalizeTypography('1–2 din')).toBe('1-2 din');
  });

  it('leaves plain hyphens and other text untouched', () => {
    expect(svc.normalizeTypography('1-2 din, 98XX')).toBe('1-2 din, 98XX');
  });

  it('is null/empty safe', () => {
    expect(svc.normalizeTypography('')).toBe('');
  });

  it('clean() also strips em-dashes so a stray dash never trips Rule 1', () => {
    expect(svc.clean('Hajur — namaste!')).toBe('Hajur - namaste!');
  });
});
