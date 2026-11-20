// One control per profile field type, shared by the member drawer and the bulk "Set field" action.
import type { MemberField } from '@swarm/domain';
import { Pill, SelectField, TextField } from '@swarm/ui/components';
import { useId } from 'react';
import type { FieldDraft } from './members-helpers';

const ENCRYPTED_HINT = 'Encrypted when stored. Segments can only test whether it is set.';

export function FieldInput({
  field,
  value,
  onChange,
  error,
  disabled,
}: {
  field: MemberField;
  value: FieldDraft;
  onChange: (value: FieldDraft) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const legendId = useId();
  const errorId = useId();
  const hint = field.encrypted ? ENCRYPTED_HINT : undefined;
  const label = field.encrypted ? `${field.label} (encrypted)` : field.label;
  const text = typeof value === 'string' ? value : '';
  const common = { label, hint, error, disabled };

  switch (field.type) {
    case 'text':
      return (
        <TextField
          {...common}
          maxLength={2000}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <TextField
          {...common}
          type="number"
          step="any"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <TextField
          {...common}
          type="date"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'boolean':
      return (
        <SelectField
          {...common}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: 'Not set' },
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
        />
      );
    case 'select':
      return (
        <SelectField
          {...common}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: 'Not set' },
            ...(text && !field.options.includes(text) ? [{ value: text, label: text }] : []),
            ...field.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      );
    case 'multi_select': {
      const chosen = Array.isArray(value) ? value : [];
      const toggle = (option: string) =>
        onChange(
          chosen.includes(option) ? chosen.filter((o) => o !== option) : [...chosen, option],
        );
      return (
        <fieldset
          aria-labelledby={legendId}
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          className="grid gap-1.5"
        >
          <legend id={legendId} className="flex items-center gap-2 text-[13px] font-semibold">
            {field.label}
            {field.encrypted && <Pill tone="brand">Encrypted</Pill>}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...field.options, ...chosen.filter((o) => !field.options.includes(o))].map(
              (option) => (
                <label
                  key={option}
                  className="flex min-h-9 cursor-pointer items-center gap-2 text-[13.5px]"
                >
                  <input
                    type="checkbox"
                    checked={chosen.includes(option)}
                    onChange={() => toggle(option)}
                    className="size-4 accent-purple"
                  />
                  {option}
                </label>
              ),
            )}
          </div>
          {hint && <p className="text-[12.5px] text-sub">{hint}</p>}
          {error && (
            <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
              {error}
            </p>
          )}
        </fieldset>
      );
    }
  }
}
