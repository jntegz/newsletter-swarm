import { describe, expect, it } from 'vitest';
import { complaintTone, describeRate } from './DomainHealth';

describe('showing a rate', () => {
  it('says nothing was sent, never 0%', () => {
    expect(describeRate(null, 0, 0, 'bounced')).toBe('Nothing sent in this range');
  });

  it('shows what the rate came from', () => {
    expect(describeRate(0.005, 21, 4210, 'bounced')).toBe('0.50% (21 bounced of 4,210)');
    expect(describeRate(0.02, 4, 200, 'bounced')).toBe('2.0% (4 bounced of 200)');
  });

  it('treats a real 0% as a rate', () => {
    expect(describeRate(0, 0, 500, 'complained')).toBe('0.00% (0 complained of 500)');
  });
});

describe('judging complaints against Gmail’s lines', () => {
  it('has nothing to judge without sends', () => {
    expect(complaintTone(null)).toBe('neutral');
  });

  it('marks the target and the limit exactly', () => {
    expect(complaintTone(0.0009)).toBe('success');
    expect(complaintTone(0.001)).toBe('neutral');
    expect(complaintTone(0.0029)).toBe('neutral');
    expect(complaintTone(0.003)).toBe('danger');
  });
});
