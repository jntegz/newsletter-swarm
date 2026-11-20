// One-line, plain-language summaries of Flow steps for the canvas and the steps list.
import type { FlowTriggerType } from '@swarm/domain';
import { TRIGGER_LABEL, type WorkingNode } from './graph';

/** Names for the ids a step refers to; undefined when the thing is unknown. */
export interface Names {
  tag?: (id: string) => string | undefined;
  field?: (id: string) => string | undefined;
  level?: (id: string) => string | undefined;
  form?: (id: string) => string | undefined;
  circle?: (id: string) => string | undefined;
  flow?: (id: string) => string | undefined;
  email?: (id: string) => string | undefined;
  ask?: (id: string) => string | undefined;
  dispatch?: (id: string) => string | undefined;
  roster?: (id: string) => string | undefined;
  milestone?: (id: string) => string | undefined;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
const plural = (n: number, unit: string) => `${n} ${n === 1 ? unit : `${unit}s`}`;

function named(
  lookup: ((id: string) => string | undefined) | undefined,
  id: unknown,
  fallback: string,
) {
  const value = str(id);
  if (!value) return undefined;
  return lookup?.(value) ?? fallback;
}

export function summarize(node: WorkingNode, names: Names = {}): string {
  const c = node.config;
  switch (node.type) {
    case 'trigger': {
      const event = str(c.event) as FlowTriggerType | undefined;
      if (!event) return 'Choose what starts the automation';
      if (Array.isArray(c.alsoStartOn) && c.alsoStartOn.length) {
        return `${c.alsoStartOn.length + 1} start events`;
      }
      const base = TRIGGER_LABEL[event] ?? event;
      const detail =
        named(names.form, c.formId, 'a form') ??
        named(names.circle, c.circleId, 'a segment') ??
        named(names.tag, c.tagId, 'a tag') ??
        named(names.field, c.fieldId, 'a field') ??
        named(names.level, c.levelId, 'a level') ??
        named(names.ask, c.askId, 'a poll or survey') ??
        named(names.dispatch, c.dispatchId, 'a post') ??
        named(names.roster, c.rosterId, 'a roster') ??
        named(names.milestone, c.milestoneId, 'a milestone') ??
        (event === 'unengaged' && num(c.days) ? `${c.days} days` : undefined) ??
        (event === 'api_event' ? str(c.name) : undefined);
      const filtered = c.filter ? ' · filtered' : '';
      return `${base}${detail ? `: ${detail}` : ''}${filtered}`;
    }
    case 'send_email': {
      const id = str(c.dispatchId);
      if (!id) return 'No email chosen';
      const subject = names.email?.(id) || 'Untitled email';
      const audience =
        c.audience === 'paid' ? ' · paid only' : c.audience === 'free' ? ' · free only' : '';
      return `${subject}${audience}`;
    }
    case 'delay': {
      if (c.mode === 'until') {
        const days = Array.isArray(c.weekdays)
          ? (c.weekdays as number[])
              .slice()
              .sort()
              .map((d) => WEEKDAY_SHORT[d])
              .join(', ')
          : '';
        const zone = c.timezone === 'member' ? "the subscriber's time" : (str(c.timezone) ?? '');
        return `Until ${days || 'a weekday'} at ${str(c.time) ?? '--:--'}${zone ? `, ${zone}` : ''}`;
      }
      const amount = num(c.amount);
      const unit = str(c.unit)?.replace(/s$/, '') ?? 'day';
      return amount ? `Wait ${plural(amount, unit)}` : 'Set how long to wait';
    }
    case 'add_tag':
    case 'remove_tag': {
      const tag = named(names.tag, c.tagId, 'a tag');
      if (!tag) return 'No tag chosen';
      return `${node.type === 'add_tag' ? 'Add' : 'Remove'} ${tag}`;
    }
    case 'update_field': {
      const field = named(names.field, c.fieldId, 'a field');
      return field ? `Set ${field}` : 'No field chosen';
    }
    case 'change_level': {
      const level = named(names.level, c.levelId, 'a level');
      if (!level) return 'No plan chosen';
      if (c.action === 'revoke') return `Revoke ${level}`;
      const days = num(c.days);
      return `Grant ${level}${days ? ` for ${plural(days, 'day')}` : ''}`;
    }
    case 'enrol_flow': {
      const flow = named(names.flow, c.flowId, 'another automation');
      return flow ? `Start ${flow}` : 'No automation chosen';
    }
    case 'branch': {
      const condition = c.condition as { children?: unknown[] } | undefined;
      const count = condition && 'children' in condition ? (condition.children?.length ?? 0) : 1;
      return count ? `If ${plural(count, 'condition')} match` : 'Add a condition';
    }
    case 'ab_split': {
      const a = num(c.percentA) ?? 50;
      const promote = c.autoPromote ? ' · picks a winner' : '';
      return `${a}% A · ${100 - a}% B${promote}`;
    }
    case 'wait_for_event': {
      const hours = num(c.timeoutHours);
      const what = c.event === 'click' ? 'a click' : 'an open';
      return `Wait for ${what}${hours ? `, up to ${hours >= 48 && hours % 24 === 0 ? plural(hours / 24, 'day') : plural(hours, 'hour')}` : ''}`;
    }
    case 'webhook_call': {
      const url = str(c.url);
      if (!url) return 'No URL yet';
      try {
        return `POST to ${new URL(url).host}`;
      } catch {
        return 'Check the URL';
      }
    }
    case 'notify_author':
      return str(c.message)?.slice(0, 60) || 'Write a message';
    case 'exit':
      return 'The run ends here';
    default:
      return '';
  }
}
