// The Gate's copy: headline, body, button label and benefits. Used by the Channel default (Gate
// settings) and by a Dispatch's own Gate; empty parts fall back to the Channel default, then to
// the site's own wording.
import { TextAreaField, TextField } from '@swarm/ui/components';
import type { GateDesign } from '@swarm/domain';
import type { GateDesignDraft } from './helpers';

const SITE_GATE_DEFAULTS = {
  // The same defaults as workers/site/src/money/gate.ts.
  headline: 'This post is for paid subscribers',
  ctaLabel: 'See plans',
};

export function GateDesignFields({
  draft,
  fallback,
  disabled,
  errors,
  onChange,
}: {
  draft: GateDesignDraft;
  /** What readers see for an empty part. */
  fallback: GateDesign;
  disabled: boolean;
  errors: Partial<Record<keyof GateDesignDraft, string>>;
  onChange: (patch: Partial<GateDesignDraft>) => void;
}) {
  return (
    <div className="grid gap-4">
      <TextField
        label="Headline"
        maxLength={120}
        value={draft.headline}
        placeholder={fallback.headline ?? SITE_GATE_DEFAULTS.headline}
        disabled={disabled}
        onChange={(e) => onChange({ headline: e.target.value })}
        error={errors.headline}
      />
      <TextAreaField
        label="Message"
        maxLength={600}
        value={draft.body}
        placeholder={
          fallback.body ??
          'Become a paid subscriber to read the rest, or sign in if you already are.'
        }
        disabled={disabled}
        onChange={(e) => onChange({ body: e.target.value })}
        error={errors.body}
      />
      <TextField
        label="Button label"
        maxLength={40}
        value={draft.ctaLabel}
        placeholder={fallback.ctaLabel ?? SITE_GATE_DEFAULTS.ctaLabel}
        disabled={disabled}
        onChange={(e) => onChange({ ctaLabel: e.target.value })}
        error={errors.ctaLabel}
      />
      <TextAreaField
        label="Benefits"
        value={draft.benefits}
        placeholder={(fallback.benefits ?? []).join('\n') || 'One per line'}
        disabled={disabled}
        onChange={(e) => onChange({ benefits: e.target.value })}
        error={errors.benefits}
        hint="One per line, up to 10."
      />
    </div>
  );
}
