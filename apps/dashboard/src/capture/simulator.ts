// The trigger simulator: a pure model of when the embed shows a form, following the loader in
// packages/engine/src/embed.ts (the trigger fires once per page view; an overlay is not shown again
// after the visitor joined; "once per N days" remembers the last showing on the visitor's device).
import { isOverlay, type Config } from './config';
import type { PreviewState } from './preview';

interface SimState {
  /** Simulated days since the first visit. */
  day: number;
  /** 1 for the first page view. */
  visit: number;
  /** Simulated scroll depth, 0–100. */
  scroll: number;
  /** Seconds spent on the page in this view. */
  waited: number;
  shown: boolean;
  closed: boolean;
  joined: boolean;
  /** The day the form was last shown, as the loader's `:seen` mark. */
  lastSeenDay: number | null;
  /** Why the latest attempt did not show the form, in plain language. */
  note: string | null;
}

export type SimAction =
  | { type: 'reset' }
  | { type: 'fire' }
  | { type: 'scroll'; to: number }
  | { type: 'wait'; seconds: number }
  | { type: 'close' }
  | { type: 'join' }
  | { type: 'visit'; afterDays: number };

/** Whether the frequency rule and the "joined" mark let the form show now. */
function blockedBy(state: SimState, config: Config): string | null {
  if (isOverlay(config.placement) && state.joined) {
    return 'Not shown: this visitor already joined, so overlays stay hidden for them.';
  }
  const f = config.frequency;
  if (f.type === 'once_per_days' && state.lastSeenDay !== null) {
    const since = state.day - state.lastSeenDay;
    if (since < f.days) {
      const left = f.days - since;
      return `Not shown: it was shown ${since === 0 ? 'earlier today' : `${since} ${since === 1 ? 'day' : 'days'} ago`}. It can show again in ${left} ${left === 1 ? 'day' : 'days'}.`;
    }
  }
  return null;
}

function show(state: SimState, config: Config): SimState {
  if (state.shown) return { ...state, note: null };
  const blocked = blockedBy(state, config);
  if (blocked) return { ...state, note: blocked };
  return { ...state, shown: true, closed: false, lastSeenDay: state.day, note: null };
}

/** Whether the simulated page view has met the trigger by now. */
function triggered(state: SimState, config: Config): boolean {
  const t = config.trigger;
  if (t.type === 'immediate') return true;
  if (t.type === 'delay') return state.waited >= t.seconds;
  if (t.type === 'scroll') return state.scroll >= t.percent;
  return false;
}

function pageView(base: SimState, config: Config): SimState {
  const next: SimState = { ...base, scroll: 0, waited: 0, shown: false, closed: false, note: null };
  return triggered(next, config) ? show(next, config) : next;
}

export function initialSim(config: Config): SimState {
  return pageView(
    {
      day: 0,
      visit: 1,
      scroll: 0,
      waited: 0,
      shown: false,
      closed: false,
      joined: false,
      lastSeenDay: null,
      note: null,
    },
    config,
  );
}

export function simulate(state: SimState, action: SimAction, config: Config): SimState {
  switch (action.type) {
    case 'reset':
      return initialSim(config);
    case 'fire':
      // The loader runs the trigger once per page view: a closed form stays closed.
      if (state.closed) return { ...state, note: 'Not shown again: it was closed on this page.' };
      return show(state, config);
    case 'scroll': {
      const next = { ...state, scroll: Math.max(0, Math.min(100, Math.round(action.to))) };
      if (state.closed || state.shown) return next;
      return triggered(next, config) ? show(next, config) : { ...next, note: null };
    }
    case 'wait': {
      const next = { ...state, waited: state.waited + action.seconds };
      if (state.closed || state.shown) return next;
      return triggered(next, config) ? show(next, config) : { ...next, note: null };
    }
    case 'close':
      return { ...state, shown: false, closed: true, note: null };
    case 'join':
      return state.shown ? { ...state, joined: true } : state;
    case 'visit':
      return pageView(
        { ...state, day: state.day + action.afterDays, visit: state.visit + 1 },
        config,
      );
  }
}

/** What the preview should draw for this state. */
export function previewState(state: SimState): PreviewState {
  if (!state.shown) return 'hidden';
  return state.joined ? 'success' : 'form';
}

interface SimButton {
  label: string;
  action: SimAction;
}

/** The buttons that fire this form's trigger, plus ones that show it doesn't fire too early. */
export function triggerButtons(config: Config): SimButton[] {
  const t = config.trigger;
  switch (t.type) {
    case 'immediate':
      return [];
    case 'delay':
      return [{ label: `Wait ${t.seconds} s`, action: { type: 'wait', seconds: t.seconds } }];
    case 'scroll': {
      const before = Math.max(0, Math.floor(t.percent / 2));
      return [
        ...(before > 0 && before < t.percent
          ? [{ label: `Scroll to ${before}%`, action: { type: 'scroll', to: before } as const }]
          : []),
        { label: `Scroll to ${t.percent}%`, action: { type: 'scroll', to: t.percent } },
      ];
    }
    case 'element_visible':
      return [
        {
          label: `Scroll ${t.selector || 'the element'} into view`,
          action: { type: 'fire' },
        },
      ];
    case 'click':
      return [{ label: `Click ${t.selector || 'the element'}`, action: { type: 'fire' } }];
    case 'event':
      return [{ label: `Fire the ${t.name || 'named'} event`, action: { type: 'fire' } }];
    case 'exit_intent':
      return [{ label: 'Move the pointer out of the window', action: { type: 'fire' } }];
    case 'scroll_velocity':
      return [{ label: 'Read a third, then scroll up fast', action: { type: 'fire' } }];
  }
}

/** How the frequency rule plays out, for the explainer under the simulator. */
export function frequencyExplainer(config: Config): string {
  const overlay = isOverlay(config.placement);
  const joined = overlay
    ? ' After someone joins, this form stays hidden for them on every later visit.'
    : '';
  if (config.frequency.type === 'every_visit') {
    return `Shows on every page view once the trigger fires.${joined}`;
  }
  const days = config.frequency.days;
  return `Shows at most once every ${days} ${days === 1 ? 'day' : 'days'} per visitor. The last showing is remembered in the visitor's browser; where storage is blocked, the rule lasts for that browsing session only.${joined}`;
}
