import { describe, expect, it } from 'vitest';
import { Labels, relative } from '../src/intel.ts';
import { UNITS_PER_METER } from '../src/protocol.ts';

describe('relative', () => {
  const m = UNITS_PER_METER;
  it('puts the view direction at 12 o\'clock and the right side at 3, in metres', () => {
    // yaw 90 looks along +y; +x is then to the right (yaw grows counter-clockwise)
    expect(relative([0, 0, 0], 90, [0, 20 * m, 0])).toMatchObject({ clock: 12, meters: 20 });
    expect(relative([0, 0, 0], 90, [10 * m, 0, 5 * m])).toMatchObject({ clock: 3, meters: 10, rise: 5 });
    expect(relative([0, 0, 0], 90, [-10 * m, 0, 0]).clock).toBe(9);
    expect(relative([0, 0, 0], 90, [0, -10 * m, 0]).clock).toBe(6);
  });
});

describe('Labels', () => {
  it('keeps a label on its entity and does not reuse a pruned one', () => {
    const labels = new Labels();
    expect(labels.label(501, 0)).toBe('E1');
    expect(labels.label(777, 0)).toBe('E2');
    expect(labels.label(501, 10)).toBe('E1');
    expect(labels.idOf('e2')).toBe(777);
    labels.prune(1000, 500);
    expect(labels.idOf('E1')).toBeNull();
    expect(labels.label(888, 1000)).toBe('E3');
  });
});
