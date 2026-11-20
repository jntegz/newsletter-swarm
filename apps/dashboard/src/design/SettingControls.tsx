// A control for every setting type a theme can declare (docs/site-themes.md, Settings types),
// drawn from its declaration: text, textarea, url, colour, font, select, checkbox, range, number,
// image and list. The theme's code decides what the form holds; this file decides how it looks.
import type { MediaAsset } from '@swarm/domain';
import type { SettingDef } from '@swarm/site-themes';
import { FONTS, isMediaId } from '@swarm/site-themes';
import { Button, Dialog, Switch, TextAreaField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { mediaQuery } from '../api/queries';
import * as Icon from '../icons';
import { focalStyle } from '../pages/common';
import { FontUpload } from '../pages/FontUpload';
import { MediaPicker } from '../pages/MediaPicker';
import { useDisclosure } from '../shell/useDisclosure';
import { fontStack } from './fonts';
import { addUploadedFont, uploadedFontName, useUploadedFonts } from './uploadedFonts';
import {
  controlKind,
  fieldProblem,
  fontName,
  fontNote,
  groupSettings,
  isVisible,
  itemTitle,
  listMax,
  newListItem,
  normaliseHex,
  optionsOf,
  withValue,
} from './settings-form';
import { moveItem } from '../site/helpers';

interface ControlContext {
  channelId: string;
  disabled: boolean;
}

/** A form of settings: grouped under their headings, each shown only while its condition holds. */
export function SettingsForm({
  defs,
  values,
  onChange,
  context,
  grouped = true,
  after,
}: {
  defs: readonly SettingDef[];
  /** The resolved values: saved where valid, else the defaults. */
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  context: ControlContext;
  grouped?: boolean;
  /** Something to draw at the end of a group, by its title: contrast warnings under Colour. */
  after?: (group: string | null) => ReactNode;
}) {
  const visible = defs.filter((def) => isVisible(def, values, defs));
  if (!visible.length) return null;
  const groups = grouped ? groupSettings(visible) : [{ title: null, defs: visible }];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
      {groups.map((group) => (
        <GroupBlock key={group.title ?? ''} title={group.title}>
          {group.defs.map((def) => (
            <SettingControl
              key={def.id}
              def={def}
              value={values[def.id]}
              onChange={(value) => onChange(def.id, value)}
              context={context}
            />
          ))}
          {after?.(group.title)}
        </GroupBlock>
      ))}
    </div>
  );
}

function GroupBlock({ title, children }: { title: string | null; children: ReactNode }) {
  const id = useId();
  if (!title) return <div className="grid grid-cols-[minmax(0,1fr)] gap-5">{children}</div>;
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <h3 id={id} className="text-[15px] font-semibold">
        {title}
      </h3>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">{children}</div>
    </section>
  );
}

function SettingControl({
  def,
  value,
  onChange,
  context,
}: {
  def: SettingDef;
  value: unknown;
  onChange: (value: unknown) => void;
  context: ControlContext;
}) {
  const { disabled } = context;
  const hint = def.info;
  switch (controlKind(def)) {
    case 'text':
    case 'url':
      return <TextControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'textarea':
      return (
        <TextAreaField
          label={def.label}
          hint={hint}
          rows={3}
          maxLength={def.max}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'color':
      return <ColourControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'font':
      return <FontControl def={def} value={value} onChange={onChange} context={context} />;
    case 'segmented':
      return <SegmentedControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'select':
      return <SelectControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'switch':
      return (
        <Switch
          label={def.label}
          hint={hint}
          checked={value === true}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'range':
      return <RangeControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'number':
      return <NumberControl def={def} value={value} onChange={onChange} disabled={disabled} />;
    case 'image':
      return <ImageControl def={def} value={value} onChange={onChange} context={context} />;
    case 'list':
      return <ListControl def={def} value={value} onChange={onChange} context={context} />;
  }
}

interface ControlProps {
  def: SettingDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}

function TextControl({ def, value, onChange, disabled }: ControlProps) {
  const [touched, setTouched] = useState(false);
  const text = typeof value === 'string' ? value : '';
  const problem = touched ? fieldProblem(def, text) : undefined;
  return (
    <TextField
      label={def.label}
      hint={
        def.info ??
        (def.type === 'url' ? 'An https address, mailto: or a path such as /about.' : undefined)
      }
      value={text}
      maxLength={def.max}
      disabled={disabled}
      inputMode={def.type === 'url' ? 'url' : undefined}
      spellCheck={def.type === 'url' ? false : undefined}
      className={def.type === 'url' ? 'font-mono text-[13px]' : ''}
      error={problem}
      onBlur={() => setTouched(true)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ColourControl({ def, value, onChange, disabled }: ControlProps) {
  const id = useId();
  const colour = typeof value === 'string' ? value : '#000000';
  // What is typed shows as typed; the setting changes once it is a colour.
  const [typed, setTyped] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const shownText = typed ?? colour;
  const invalid = touched && typed !== null && normaliseHex(typed) === null;
  const hintId = def.info ? `${id}-hint` : undefined;
  const errorId = invalid ? `${id}-error` : undefined;
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold">
        {def.label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={normaliseHex(shownText) ?? colour}
          disabled={disabled}
          aria-label={`${def.label}: colour picker`}
          onChange={(e) => {
            setTyped(null);
            onChange(e.target.value);
          }}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-control border border-line-control bg-surface p-1 disabled:cursor-not-allowed"
        />
        <input
          id={id}
          type="text"
          value={shownText}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setTyped(e.target.value);
            const hex = normaliseHex(e.target.value);
            if (hex) onChange(hex);
          }}
          onBlur={() => {
            setTouched(true);
            if (typed !== null && normaliseHex(typed)) setTyped(null);
          }}
          className={`line-input min-h-[36px]! w-[120px] font-mono text-[13px] ${invalid ? 'border-danger!' : ''}`}
        />
      </div>
      {def.info && (
        <p id={hintId} className="text-[12.5px] text-sub">
          {def.info}
        </p>
      )}
      {invalid && (
        <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
          Use a colour like #2f5d50.
        </p>
      )}
    </div>
  );
}

function FontControl({
  def,
  value,
  onChange,
  context,
}: {
  def: SettingDef;
  value: unknown;
  onChange: (value: unknown) => void;
  context: ControlContext;
}) {
  const { channelId, disabled } = context;
  const menu = useDisclosure();
  const name = useId();
  const fonts = useUploadedFonts(channelId);
  const [uploading, setUploading] = useState(false);
  // The upload form takes focus when it opens, and gives it back to the menu button when it closes.
  const uploadHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (uploading) uploadHeading.current?.focus();
  }, [uploading]);
  const closeUpload = () => {
    setUploading(false);
    document.getElementById(menu.buttonProps.id)?.focus();
  };
  const fallback =
    typeof def.default === 'string' && !isMediaId(def.default) ? def.default : 'system';
  const chosen = typeof value === 'string' ? value : fallback;
  const uploaded = isMediaId(chosen) ? fonts.data?.find((f) => f.id === chosen) : undefined;
  // A font that was deleted after it was chosen: the site draws the setting's default instead.
  const missing = isMediaId(chosen) && fonts.isSuccess && !uploaded;
  const current = missing ? fallback : chosen;
  const label = uploaded ? uploadedFontName(uploaded) : fontName(current);
  const itemClass = (selected: boolean) =>
    `line-menu-item cursor-pointer justify-between has-focus-visible:bg-surface-alt has-focus-visible:outline-2 has-focus-visible:outline-offset-[-2px] has-focus-visible:outline-purple ${
      selected ? 'bg-lavender' : ''
    }`;
  const radio = (font: string) => (
    <input
      type="radio"
      name={name}
      className="sr-only"
      checked={font === chosen}
      onChange={() => onChange(font)}
      onClick={() => menu.close(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onChange(font);
          menu.close(true);
        }
      }}
    />
  );
  return (
    <div className="relative grid content-start gap-1.5">
      <span id={`${name}-label`} className="text-[13px] font-semibold">
        {def.label}
      </span>
      <button
        type="button"
        {...menu.buttonProps}
        disabled={disabled}
        aria-labelledby={`${name}-label ${name}-value`}
        aria-describedby={missing ? `${name}-missing` : undefined}
        className="line-input flex min-h-[44px] items-center justify-between gap-3 text-left disabled:cursor-not-allowed"
      >
        <span
          id={`${name}-value`}
          className="min-w-0 truncate text-[17px]"
          style={{ fontFamily: fontStack(current) }}
        >
          {label}
        </span>
        <Icon.ChevronDown size={16} className="shrink-0 text-sub" />
      </button>
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
      {missing && (
        <p
          id={`${name}-missing`}
          className="flex items-start gap-2 rounded-control bg-surface-alt px-3 py-2 text-[13px] leading-[1.5] text-sub"
        >
          <Icon.Alert size={16} className="mt-0.5 shrink-0" />
          <span>
            The font chosen here is no longer in the media library, so the site uses{' '}
            {fontName(fallback)}, the theme’s own. Choose another, or upload it again.
          </span>
        </p>
      )}
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+4px)] right-0 left-0 max-h-[380px] overflow-y-auto"
      >
        <fieldset>
          <legend className="sr-only">{def.label}</legend>
          {FONTS.map((font) => (
            <label key={font} className={itemClass(font === chosen)}>
              {radio(font)}
              <span className="text-[17px]" style={{ fontFamily: fontStack(font) }}>
                {fontName(font)}
              </span>
              <span className="text-[12.5px] text-sub">{fontNote(font)}</span>
            </label>
          ))}
        </fieldset>
        {fonts.data && fonts.data.length > 0 && (
          <div className="mt-1 border-t border-line pt-1">
            <fieldset>
              <legend className="px-2.5 pt-2 pb-1 text-[13px] font-semibold text-sub">
                Your fonts
              </legend>
              {fonts.data.map((font) => (
                <label key={font.id} className={itemClass(font.id === chosen)}>
                  {radio(font.id)}
                  <span
                    className="min-w-0 truncate text-[17px]"
                    style={{ fontFamily: fontStack(font.id) }}
                  >
                    {uploadedFontName(font)}
                  </span>
                  <span className="shrink-0 text-[12.5px] text-sub">Uploaded</span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
        <div className="mt-1 border-t border-line pt-1">
          <button
            type="button"
            className="line-menu-item text-left font-semibold"
            onClick={() => {
              menu.close();
              setUploading(true);
            }}
          >
            <Icon.Upload size={16} className="shrink-0" />
            Upload a font…
          </button>
        </div>
      </div>
      {uploading && (
        <section
          aria-labelledby={`${name}-upload`}
          className="mt-1 grid gap-3 rounded-control border border-line bg-surface p-4"
        >
          <h4
            id={`${name}-upload`}
            ref={uploadHeading}
            tabIndex={-1}
            className="text-[14px] font-semibold"
          >
            Upload a font for {def.label.toLowerCase()}
          </h4>
          <FontUpload
            channelId={channelId}
            onCancel={closeUpload}
            onUploaded={(asset) => {
              addUploadedFont(asset);
              onChange(asset.id);
              closeUpload();
            }}
          />
        </section>
      )}
    </div>
  );
}

function SegmentedControl({ def, value, onChange, disabled }: ControlProps) {
  const name = useId();
  const options = optionsOf(def);
  return (
    <fieldset className="grid content-start gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-[13px] font-semibold">{def.label}</legend>
      <div className="grid auto-cols-fr grid-flow-col rounded-control border border-line bg-surface-alt p-[3px]">
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              className={`inline-flex min-h-[30px] cursor-pointer items-center justify-center rounded-[6px] px-2 py-1 text-center text-[13px] leading-[1.25] transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
                checked
                  ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line-control)]'
                  : 'text-sub hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
    </fieldset>
  );
}

function SelectControl({ def, value, onChange, disabled }: ControlProps) {
  const id = useId();
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold">
        {def.label}
      </label>
      <select
        id={id}
        className="line-input"
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {optionsOf(def).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
    </div>
  );
}

function RangeControl({ def, value, onChange, disabled }: ControlProps) {
  const id = useId();
  const number = typeof value === 'number' ? value : (def.min ?? 0);
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold">
          {def.label}
        </label>
        <output htmlFor={id} className="tabular text-[13px] text-sub">
          {number}
          {def.unit ?? ''}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={def.step ?? 1}
        value={number}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full accent-purple"
      />
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
    </div>
  );
}

function NumberControl({ def, value, onChange, disabled }: ControlProps) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (typeof value === 'number' ? String(value) : '');
  const parsed = shown.trim() === '' ? null : Number(shown);
  const problem =
    text !== null && parsed !== null && Number.isFinite(parsed)
      ? fieldProblem(def, parsed)
      : text !== null && parsed !== null
        ? 'Use a number.'
        : undefined;
  return (
    <TextField
      label={def.unit ? `${def.label} (${def.unit})` : def.label}
      hint={def.info}
      type="number"
      inputMode="decimal"
      min={def.min}
      max={def.max}
      step={def.step}
      value={shown}
      disabled={disabled}
      error={problem}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value.trim() === '' ? null : Number(e.target.value);
        if (n === null) onChange(undefined);
        else if (Number.isFinite(n) && !fieldProblem(def, n)) onChange(n);
      }}
      onBlur={() => {
        if (!problem) setText(null);
      }}
    />
  );
}

function useMediaItem(channelId: string, id: unknown) {
  const media = useQuery({
    ...mediaQuery(channelId, '', 'image'),
    enabled: typeof id === 'string',
  });
  const asset = typeof id === 'string' ? media.data?.find((m) => m.id === id) : undefined;
  return { asset, pending: media.isPending && typeof id === 'string' };
}

function ImageControl({
  def,
  value,
  onChange,
  context,
}: {
  def: SettingDef;
  value: unknown;
  onChange: (value: unknown) => void;
  context: ControlContext;
}) {
  const { channelId, disabled } = context;
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const { asset, pending } = useMediaItem(channelId, value);
  const id = useId();
  const has = typeof value === 'string' && value !== '';
  return (
    <div className="grid content-start gap-1.5" role="group" aria-labelledby={id}>
      <span id={id} className="text-[13px] font-semibold">
        {def.label}
      </span>
      <div className="flex items-center gap-3">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[8px] border border-line bg-surface-alt text-sub">
          {asset ? (
            <img
              src={asset.url}
              alt=""
              className="size-full object-cover"
              style={focalStyle(asset)}
            />
          ) : (
            <Icon.Image size={20} />
          )}
        </div>
        <div className="grid min-w-0 gap-1">
          <p className="truncate text-[13px] text-sub">
            {!has
              ? 'No image'
              : asset
                ? asset.altText || 'An image without alt text'
                : pending
                  ? 'Loading…'
                  : 'Not in the media library any more'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setChosen(asset ?? null);
                setPicking(true);
              }}
            >
              {has ? 'Change image' : 'Choose image'}
            </Button>
            {has && (
              <Button
                variant="quiet"
                size="sm"
                disabled={disabled}
                onClick={() => onChange(undefined)}
              >
                Remove
                <span className="sr-only"> {def.label.toLowerCase()}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title={`Choose ${def.label.toLowerCase()}`}
        description="From your media library. Upload one here if it isn’t there yet."
        actions={
          <>
            <Button variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              disabled={!chosen}
              onClick={() => {
                if (chosen) onChange(chosen.id);
                setPicking(false);
              }}
            >
              Use image
            </Button>
          </>
        }
      >
        {picking && <MediaPicker channelId={channelId} chosen={chosen} onChoose={setChosen} />}
      </Dialog>
    </div>
  );
}

function ListControl({
  def,
  value,
  onChange,
  context,
}: {
  def: SettingDef;
  value: unknown;
  onChange: (value: unknown) => void;
  context: ControlContext;
}) {
  const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const fields = (def.fields ?? []).filter((f) => f.type !== 'list');
  const max = listMax(def);
  const id = useId();
  const [open, setOpen] = useState<number | null>(null);
  const set = (next: Record<string, unknown>[]) => onChange(next);

  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2"
      role="group"
      aria-labelledby={id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span id={id} className="text-[13px] font-semibold">
          {def.label}
        </span>
        <span className="tabular text-[12.5px] text-sub">
          {items.length} of {max}
        </span>
      </div>
      {def.info && <p className="text-[12.5px] text-sub">{def.info}</p>}
      {items.length === 0 && <p className="text-[13px] text-sub">Nothing here yet.</p>}
      {items.length > 0 && (
        <ol className="divide-y divide-line rounded-control border border-line">
          {items.map((item, index) => {
            const title = itemTitle(item, fields, index);
            const expanded = open === index;
            return (
              <li key={index} className="min-w-0">
                <div className="flex items-center gap-1 pr-1.5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : index)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-control px-3 text-left text-[13.5px] hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple"
                  >
                    <Icon.ChevronRight
                      size={14}
                      className={`shrink-0 text-sub transition-transform ${expanded ? 'rotate-90' : ''}`}
                    />
                    <span className="truncate">{title}</span>
                  </button>
                  <IconButton
                    label={`Move ${title} up`}
                    disabled={context.disabled || index === 0}
                    onClick={() => {
                      set(moveItem(items, index, index - 1));
                      if (expanded) setOpen(index - 1);
                    }}
                  >
                    <Icon.ChevronDown size={16} className="rotate-180" />
                  </IconButton>
                  <IconButton
                    label={`Move ${title} down`}
                    disabled={context.disabled || index === items.length - 1}
                    onClick={() => {
                      set(moveItem(items, index, index + 1));
                      if (expanded) setOpen(index + 1);
                    }}
                  >
                    <Icon.ChevronDown size={16} />
                  </IconButton>
                  <IconButton
                    label={`Remove ${title}`}
                    disabled={context.disabled}
                    onClick={() => {
                      set(items.filter((_, i) => i !== index));
                      setOpen(null);
                    }}
                  >
                    <Icon.Close size={16} />
                  </IconButton>
                </div>
                {expanded && (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-4 border-t border-line px-3 pt-3 pb-4">
                    {fields.map((field) => (
                      <SettingControl
                        key={field.id}
                        def={field}
                        value={item[field.id]}
                        context={context}
                        onChange={(v) =>
                          set(items.map((it, i) => (i === index ? withValue(it, field.id, v) : it)))
                        }
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={context.disabled || items.length >= max}
          onClick={() => {
            set([...items, newListItem(fields)]);
            setOpen(items.length);
          }}
        >
          <Icon.Plus size={16} /> Add item
          <span className="sr-only"> to {def.label.toLowerCase()}</span>
        </Button>
        {items.length >= max && (
          <span className="text-[12.5px] text-sub">That’s the most this list holds.</span>
        )}
      </div>
    </div>
  );
}

export function IconButton({
  label,
  disabled,
  onClick,
  children,
  pressed,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-[6px] text-sub transition-colors hover:bg-surface-alt hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
