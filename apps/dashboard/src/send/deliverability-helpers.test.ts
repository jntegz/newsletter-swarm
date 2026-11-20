import { describe, expect, it } from 'vitest';
import { alignmentPercent, formatRate, gaugePosition, GAUGE_MAX } from './deliverability-helpers';

describe('deliverability helpers', () => {
  it('formats small rates with two decimals', () => {
    expect(formatRate(0.0008)).toBe('0.08%');
    expect(formatRate(0.003)).toBe('0.3%');
    expect(formatRate(null)).toBe('—');
  });

  it('places the ceiling at 60% of the gauge and clips above the scale', () => {
    expect(gaugePosition(0.003)).toBeCloseTo(0.6);
    expect(gaugePosition(0.001)).toBeCloseTo(0.2);
    expect(gaugePosition(GAUGE_MAX * 2)).toBe(1);
    expect(gaugePosition(null)).toBe(0);
  });

  it('computes alignment to one decimal', () => {
    expect(alignmentPercent(997, 1000)).toBe(99.7);
    expect(alignmentPercent(0, 0)).toBeNull();
  });
});
