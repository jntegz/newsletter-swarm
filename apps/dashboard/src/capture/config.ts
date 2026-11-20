// Capture Form builder helpers: defaults, labels, client-side validation that mirrors
// CaptureFormConfigSchema in @swarm/domain, and a plain-language list of what a publish changes.
// The server validates again; these checks only let the builder explain problems before saving.
import {
  consentHtmlProblem,
  type CaptureFormConfig,
  type FormField,
  type FormTrigger,
  type MemberField,
} from '@swarm/domain';

export type Config = CaptureFormConfig;
type Placement = Config['placement'];
type Layout = Config['layout'];
export type TriggerType = FormTrigger['type'];
type Frequency = Config['frequency'];
type Success = Config['success'];

export const SWARM_INDIGO = '#6c4cf1';
export const MAX_FIELDS = 12;
export const SUCCESS_MAX = 80;

/** The default form, identical to defaultCaptureFormConfig() on the server. */
export function defaultConfig(): Config {
  return {
    fields: [{ key: 'email', label: 'Email', placeholder: 'you@example.com', required: true }],
    consent: null,
    layout: 'regular',
    placement: 'inline',
    trigger: { type: 'immediate' },
    frequency: { type: 'every_visit' },
    success: { type: 'message', message: 'Check your inbox to confirm.' },
    doubleOptIn: null,
    theme: { accentColor: null, mode: 'auto' },
    allowedOrigins: [],
    copy: { heading: 'Join the list', body: '', button: 'Join' },
  };
}

export const LAYOUTS: { value: Layout; label: string; hint: string }[] = [
  { value: 'regular', label: 'Regular', hint: 'Heading, text and stacked fields.' },
  { value: 'slim', label: 'Slim', hint: 'Fields and button on one line, no heading.' },
];

export const PLACEMENTS: { value: Placement; label: string; hint: string }[] = [
  { value: 'inline', label: 'Inline', hint: 'Inside the page, where you paste the code.' },
  { value: 'slide_in_left', label: 'Slide-in, left', hint: 'A card in the bottom left corner.' },
  { value: 'slide_in_right', label: 'Slide-in, right', hint: 'A card in the bottom right corner.' },
  { value: 'popup', label: 'Popup', hint: 'Centred over a dimmed page.' },
  { value: 'sticky_top', label: 'Sticky bar, top', hint: 'A full-width bar fixed to the top.' },
  {
    value: 'sticky_bottom',
    label: 'Sticky bar, bottom',
    hint: 'A full-width bar fixed to the bottom.',
  },
];

export const TRIGGERS: { value: TriggerType; label: string }[] = [
  { value: 'immediate', label: 'As soon as the page loads' },
  { value: 'delay', label: 'After a delay' },
  { value: 'scroll', label: 'After scrolling part of the page' },
  { value: 'element_visible', label: 'When an element comes into view' },
  { value: 'click', label: 'When something is clicked' },
  { value: 'event', label: 'When your site fires an event' },
  { value: 'exit_intent', label: 'When the visitor is about to leave (exit intent)' },
  { value: 'scroll_velocity', label: 'When a reader scrolls back up fast (touch screens)' },
];

/** A trigger of a new type, keeping the parameter where it still makes sense. */
export function triggerOfType(type: TriggerType, previous?: FormTrigger): FormTrigger {
  switch (type) {
    case 'delay':
      return { type, seconds: previous?.type === 'delay' ? previous.seconds : 5 };
    case 'scroll':
      return { type, percent: previous?.type === 'scroll' ? previous.percent : 50 };
    case 'element_visible':
    case 'click':
      return {
        type,
        selector:
          previous?.type === 'element_visible' || previous?.type === 'click'
            ? previous.selector
            : '',
      };
    case 'event':
      return { type, name: previous?.type === 'event' ? previous.name : '' };
    default:
      return { type };
  }
}

export function triggerSummary(trigger: FormTrigger): string {
  switch (trigger.type) {
    case 'immediate':
      return 'As soon as the page loads';
    case 'delay':
      return `After ${trigger.seconds} s on the page`;
    case 'scroll':
      return `After scrolling ${trigger.percent}% of the page`;
    case 'element_visible':
      return `When ${trigger.selector || 'an element'} comes into view`;
    case 'click':
      return `When ${trigger.selector || 'an element'} is clicked`;
    case 'event':
      return `When the ${trigger.name || 'named'} event fires`;
    case 'exit_intent':
      return 'When the pointer leaves the window (exit intent)';
    case 'scroll_velocity':
      return 'When a reader scrolls back up fast';
  }
}

export function frequencySummary(frequency: Frequency): string {
  return frequency.type === 'every_visit'
    ? 'Every visit'
    : `Once every ${frequency.days} ${frequency.days === 1 ? 'day' : 'days'}`;
}

export const placementLabel = (placement: Placement) =>
  PLACEMENTS.find((p) => p.value === placement)?.label ?? placement;

export const isOverlay = (placement: Placement) => placement !== 'inline';

// ---------------------------------------------------------------------------------------------
// Fields

export const STANDARD_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
] as const;

export const profileKey = (field: MemberField) => `field:${field.key}`;

/** Profile fields of the Channel that are not on the form yet. */
export function addableProfileFields(config: Config, defs: readonly MemberField[]): MemberField[] {
  const used = new Set(config.fields.map((f) => f.key));
  return defs.filter((d) => !used.has(profileKey(d)));
}

export function newField(key: string, label: string, def?: MemberField): FormField {
  const field: FormField = { key, label: label.slice(0, 80), required: false };
  if (def?.type === 'select') field.display = 'dropdown';
  return field;
}

/** Moves the field at `index` by `delta`, keeping email where the operator put it. */
export function moveField(fields: FormField[], index: number, delta: -1 | 1): FormField[] {
  const target = index + delta;
  if (target < 0 || target >= fields.length) return fields;
  const next = [...fields];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(target, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Origins

/** `https://host[:port]` (or http://localhost) as its origin, or null when it isn't one. */
export function normaliseOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) return null;
  try {
    const url = new URL(trimmed);
    const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if ((url.protocol === 'https:' || local) && url.origin !== 'null') return url.origin;
  } catch {
    // not a URL
  }
  return null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation, mirroring CaptureFormConfigSchema

export interface Issue {
  /** A dotted path such as `success.message` or `fields.2.label`. */
  path: string;
  message: string;
}

const SELECTOR_MAX = 200;
const EVENT_NAME = /^[A-Za-z0-9_:.-]{1,60}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const FIELD_KEY = /^(email|first_name|last_name|field:[a-z][a-z0-9_]{0,39})$/;

const int = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

export function validateConfig(config: Config): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (config.fields.length < 1 || config.fields.length > MAX_FIELDS) {
    add('fields', `Use between 1 and ${MAX_FIELDS} fields.`);
  }
  config.fields.forEach((field, i) => {
    if (!FIELD_KEY.test(field.key))
      add(`fields.${i}.key`, 'Pick email, a name or a profile field.');
    const label = field.label.trim();
    if (!label) add(`fields.${i}.label`, 'Label the field.');
    else if (label.length > 80) add(`fields.${i}.label`, 'Keep the label to 80 characters.');
    if ((field.placeholder?.trim().length ?? 0) > 80) {
      add(`fields.${i}.placeholder`, 'Keep the placeholder to 80 characters.');
    }
  });
  const email = config.fields.filter((f) => f.key === 'email');
  if (email.length !== 1) add('fields', 'Include the email field once.');
  else if (!email[0]!.required) add('fields', 'The email field is required.');
  const keys = config.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) add('fields', 'Use each field once.');

  if (config.consent) {
    const text = config.consent.text.trim();
    if (!text) add('consent.text', 'Write the consent text, or turn consent off.');
    else if (text.length > 1000) add('consent.text', 'Keep the consent text to 1,000 characters.');
    else {
      const problem = consentHtmlProblem(text);
      if (problem) add('consent.text', problem);
    }
  }

  const t = config.trigger;
  if (t.type === 'delay' && !int(t.seconds, 1, 600)) {
    add('trigger.seconds', 'Use a whole number of seconds from 1 to 600.');
  }
  if (t.type === 'scroll' && !int(t.percent, 1, 100)) {
    add('trigger.percent', 'Use a whole percentage from 1 to 100.');
  }
  if (t.type === 'element_visible' || t.type === 'click') {
    const selector = t.selector.trim();
    if (!selector) add('trigger.selector', 'Enter a CSS selector such as #signup or .open-form.');
    else if (selector.length > SELECTOR_MAX) add('trigger.selector', 'Keep it to 200 characters.');
  }
  if (t.type === 'event' && !EVENT_NAME.test(t.name)) {
    add('trigger.name', 'Use letters, digits, dots and dashes.');
  }

  if (config.frequency.type === 'once_per_days' && !int(config.frequency.days, 1, 365)) {
    add('frequency.days', 'Use a whole number of days from 1 to 365.');
  }

  if (config.success.type === 'message') {
    const message = config.success.message.trim();
    if (!message) add('success.message', 'Write a short thank-you message.');
    else if (message.length > SUCCESS_MAX) {
      add('success.message', `Keep the message to ${SUCCESS_MAX} characters.`);
    }
  } else if (!isHttpsUrl(config.success.url) || config.success.url.trim().length > 2048) {
    add('success.url', 'Use a full https:// address.');
  }

  if (config.theme.accentColor !== null && !HEX.test(config.theme.accentColor)) {
    add('theme.accentColor', 'Use a hex colour such as #6c4cf1.');
  }

  if (config.allowedOrigins.length > 20) add('allowedOrigins', 'List at most 20 sites.');
  config.allowedOrigins.forEach((origin, i) => {
    if (!normaliseOrigin(origin)) {
      add(`allowedOrigins.${i}`, 'Use a site origin such as https://example.com.');
    }
  });

  if (config.copy.heading.trim().length > 120) {
    add('copy.heading', 'Keep the heading to 120 characters.');
  }
  if (config.copy.body.trim().length > 300) add('copy.body', 'Keep the text to 300 characters.');
  const button = config.copy.button.trim();
  if (!button) add('copy.button', 'Name the button.');
  else if (button.length > 40) add('copy.button', 'Keep the button to 40 characters.');

  return issues;
}

/** The first issue at exactly this path. */
export const issueAt = (issues: readonly Issue[], path: string) =>
  issues.find((i) => i.path === path)?.message;

// ---------------------------------------------------------------------------------------------
// What a publish changes

const doiLabel = (value: boolean | null) =>
  value === null ? 'Publication default' : value ? 'On' : 'Off';

const fieldList = (fields: readonly FormField[]) =>
  fields.map((f) => `${f.label}${f.required ? ' (required)' : ''}`).join(', ');

/**
 * Plain-language lines describing how `next` differs from what is live. Before the first
 * publish there is nothing live, so the summary describes the whole form.
 */
export function describeChanges(live: Config | null, next: Config): string[] {
  if (!live) {
    return [
      `Fields: ${fieldList(next.fields)}`,
      `${placementLabel(next.placement)}, ${next.layout === 'slim' ? 'slim' : 'regular'} layout`,
      `Shows ${triggerSummary(next.trigger).toLowerCase()}, ${frequencySummary(next.frequency).toLowerCase()}`,
    ];
  }
  const lines: string[] = [];
  const diff = (label: string, before: string, after: string) => {
    if (before !== after) lines.push(`${label}: ${before} → ${after}`);
  };
  diff('Fields', fieldList(live.fields), fieldList(next.fields));
  diff(
    'Consent',
    live.consent ? live.consent.text : 'None',
    next.consent ? next.consent.text : 'None',
  );
  diff(
    'Layout',
    live.layout === 'slim' ? 'Slim' : 'Regular',
    next.layout === 'slim' ? 'Slim' : 'Regular',
  );
  diff('Placement', placementLabel(live.placement), placementLabel(next.placement));
  diff('Trigger', triggerSummary(live.trigger), triggerSummary(next.trigger));
  diff('Frequency', frequencySummary(live.frequency), frequencySummary(next.frequency));
  const success = (s: Success) =>
    s.type === 'message' ? `Message "${s.message}"` : `Go to ${s.url}`;
  diff('After joining', success(live.success), success(next.success));
  diff('Double opt-in', doiLabel(live.doubleOptIn), doiLabel(next.doubleOptIn));
  diff(
    'Accent colour',
    live.theme.accentColor ?? 'Publication colour',
    next.theme.accentColor ?? 'Publication colour',
  );
  diff('Colour scheme', live.theme.mode, next.theme.mode);
  diff(
    'Allowed sites',
    live.allowedOrigins.join(', ') || 'Any site',
    next.allowedOrigins.join(', ') || 'Any site',
  );
  diff('Heading', live.copy.heading || 'None', next.copy.heading || 'None');
  diff('Text', live.copy.body || 'None', next.copy.body || 'None');
  diff('Button', live.copy.button, next.copy.button);
  return lines;
}

/** The colour the live form uses: its own, else the Channel's, else Swarm indigo. */
export function effectiveAccent(config: Config, channelAccent: string | null | undefined): string {
  const pick = config.theme.accentColor ?? channelAccent ?? SWARM_INDIGO;
  return HEX.test(pick) ? pick : SWARM_INDIGO;
}
