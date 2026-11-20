import { describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from './config';
import {
  frequencyExplainer,
  initialSim,
  previewState,
  simulate,
  triggerButtons,
  type SimAction,
} from './simulator';

const cfg = (patch: Partial<Config>): Config => ({ ...defaultConfig(), ...patch });

function run(config: Config, actions: SimAction[]) {
  return actions.reduce((state, action) => simulate(state, action, config), initialSim(config));
}

describe('simulator', () => {
  it('shows immediate forms straight away', () => {
    expect(previewState(initialSim(cfg({})))).toBe('form');
  });

  it('waits for the delay', () => {
    const config = cfg({ trigger: { type: 'delay', seconds: 5 } });
    expect(initialSim(config).shown).toBe(false);
    expect(run(config, [{ type: 'wait', seconds: 3 }]).shown).toBe(false);
    expect(
      run(config, [
        { type: 'wait', seconds: 3 },
        { type: 'wait', seconds: 2 },
      ]).shown,
    ).toBe(true);
  });

  it('shows on scroll depth only once it is reached', () => {
    const config = cfg({ trigger: { type: 'scroll', percent: 60 } });
    expect(run(config, [{ type: 'scroll', to: 30 }]).shown).toBe(false);
    expect(run(config, [{ type: 'scroll', to: 60 }]).shown).toBe(true);
    expect(triggerButtons(config).map((b) => b.label)).toEqual(['Scroll to 30%', 'Scroll to 60%']);
  });

  it('fires event-like triggers once per page view', () => {
    const config = cfg({ placement: 'popup', trigger: { type: 'exit_intent' } });
    const closed = run(config, [{ type: 'fire' }, { type: 'close' }, { type: 'fire' }]);
    expect(closed.shown).toBe(false);
    expect(closed.note).toMatch(/closed on this page/);
    expect(
      run(config, [
        { type: 'fire' },
        { type: 'close' },
        { type: 'visit', afterDays: 0 },
        { type: 'fire' },
      ]).shown,
    ).toBe(true);
  });

  it('applies once-per-days frequency across visits', () => {
    const config = cfg({ placement: 'popup', frequency: { type: 'once_per_days', days: 7 } });
    const sameDay = run(config, [{ type: 'visit', afterDays: 0 }]);
    expect(sameDay.shown).toBe(false);
    expect(sameDay.note).toMatch(/earlier today.*7 days/);
    const later = run(config, [{ type: 'visit', afterDays: 3 }]);
    expect(later.note).toMatch(/3 days ago.*4 days/);
    expect(run(config, [{ type: 'visit', afterDays: 7 }]).shown).toBe(true);
  });

  it('keeps overlays hidden after joining, but not inline forms', () => {
    const overlay = cfg({ placement: 'slide_in_right' });
    const joined = run(overlay, [{ type: 'join' }]);
    expect(previewState(joined)).toBe('success');
    expect(run(overlay, [{ type: 'join' }, { type: 'visit', afterDays: 30 }]).shown).toBe(false);
    const inline = cfg({});
    expect(run(inline, [{ type: 'join' }, { type: 'visit', afterDays: 0 }]).shown).toBe(true);
  });

  it('names the trigger in its buttons', () => {
    expect(triggerButtons(cfg({ trigger: { type: 'delay', seconds: 5 } }))[0]?.label).toBe(
      'Wait 5 s',
    );
    expect(triggerButtons(cfg({ trigger: { type: 'exit_intent' } }))[0]?.label).toBe(
      'Move the pointer out of the window',
    );
    expect(triggerButtons(cfg({}))).toEqual([]);
  });

  it('explains frequency in plain language', () => {
    expect(frequencyExplainer(cfg({}))).toMatch(/every page view/);
    expect(frequencyExplainer(cfg({ frequency: { type: 'once_per_days', days: 1 } }))).toMatch(
      /once every 1 day per visitor.*browsing session/,
    );
  });
});
