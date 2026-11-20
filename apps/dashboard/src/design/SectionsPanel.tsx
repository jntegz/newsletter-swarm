// Sections: the home page's sections in order. Drag a row to move it, or use Move up and Move down
// (also Alt with an arrow key on a row). The eye hides a section; the menu duplicates or deletes
// it, starts an A/B test and sets who sees it and where. Each row says what the section reached
// and signed up over the chosen period. Choosing a row opens its settings, drawn from its schema,
// with an A | B switch and the results while a test runs.
import type { Audience, Design, Device, SectionInstance, Variant } from '@swarm/site-themes';
import { isTesting, resolveSettings } from '@swarm/site-themes';
import { Button, Checkbox } from '@swarm/ui/components';
import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import * as Icon from '../icons';
import { useToast } from '../shell/toast';
import { useDisclosure } from '../shell/useDisclosure';
import { withSections } from './draft';
import {
  AUDIENCES,
  DEVICES,
  addProblem,
  addSection,
  dropSection,
  duplicateSection,
  moveSection,
  removeSection,
  sectionNotes,
  sectionTitle,
  updateSection,
} from './sections';
import { IconButton, SettingsForm } from './SettingControls';
import { withValue } from './settings-form';
import { StatsPeriod, TestResults, VariantSwitch } from './SectionTest';
import { useStudio } from './studio';
import {
  countsLine,
  endTest,
  sectionCounts,
  startTest,
  testProblem,
  withVariantSettings,
} from './tests';

export function SectionsPanel() {
  const { selected, sections, setEditingB } = useStudio();
  // Which variant each section's settings show, while it has a running test.
  const [variants, setVariants] = useState<Record<string, Variant>>({});
  const open = selected ? sections.find((s) => s.id === selected) : undefined;
  const variant: Variant = open && isTesting(open) ? (variants[open.id] ?? 'a') : 'a';
  const editing = open && variant === 'b' ? open.id : null;
  // The preview follows: B of the section whose B is open.
  useEffect(() => setEditingB(editing), [editing, setEditingB]);
  useEffect(() => () => setEditingB(null), [setEditingB]);
  const choose = (id: string, next: Variant) => setVariants((v) => ({ ...v, [id]: next }));
  return open ? (
    <SectionSettings section={open} variant={variant} onVariant={(next) => choose(open.id, next)} />
  ) : (
    <SectionList onTestStarted={(id) => choose(id, 'b')} />
  );
}

/** Changes the page's sections, making them concrete from the theme's defaults the first time. */
function useSectionChange() {
  const { draft } = useStudio();
  return (change: (sections: SectionInstance[]) => SectionInstance[]) =>
    draft.change((d) => withSections(d, draft.theme?.defaults ?? [], change));
}

function SectionList({ onTestStarted }: { onTestStarted: (id: string) => void }) {
  const { sections, draft, canEdit, select, stats, statsDays } = useStudio();
  const theme = draft.theme;
  const changeSections = useSectionChange();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    rows.current.get(id)?.querySelector<HTMLElement>('[data-row-main]')?.focus();
  });

  if (!theme) {
    return (
      <p className="text-[13px] text-sub">
        The theme’s files have problems, so its sections can’t be shown. Fix them in Code.
      </p>
    );
  }

  const nameOf = (s: SectionInstance) => sectionTitle(s, theme.schemas[s.type]).name;

  const move = (id: string, by: number) => {
    const index = sections.findIndex((s) => s.id === id);
    const to = index + by;
    if (to < 0 || to >= sections.length) return;
    changeSections((list) => moveSection(list, id, by));
    focusAfter.current = id;
    const section = sections[index];
    if (section)
      setAnnounce(`${nameOf(section)} moved to position ${to + 1} of ${sections.length}.`);
  };

  const remove = (section: SectionInstance) => {
    const before: Design = draft.design;
    const { index } = removeSection(sections, section.id);
    changeSections((list) => removeSection(list, section.id).sections);
    const next = sections[index + 1] ?? sections[index - 1];
    if (next) focusAfter.current = next.id;
    toast.show({
      message: `${nameOf(section)} deleted.`,
      action: { label: 'Undo', onAction: () => draft.change(() => before) },
    });
  };

  const duplicate = (section: SectionInstance) => {
    const { added } = duplicateSection(sections, section.id);
    changeSections((list) => duplicateSection(list, section.id).sections);
    if (added) {
      // The copy gets the next free id; the list keeps the same rules, so this is the one.
      focusAfter.current = added.id;
      setAnnounce(`${nameOf(section)} duplicated.`);
    }
  };

  const test = (section: SectionInstance) => {
    const before: Design = draft.design;
    changeSections((list) => startTest(list, section.id));
    onTestStarted(section.id);
    select(section.id, { reveal: true });
    toast.show({
      message: `Testing a variant of ${nameOf(section)}. Change B, then publish to start.`,
      action: { label: 'Undo', onAction: () => draft.change(() => before) },
    });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragging !== null && dropAt !== null) {
      changeSections((list) => dropSection(list, dragging, dropAt));
      const section = sections.find((s) => s.id === dragging);
      if (section) setAnnounce(`${nameOf(section)} moved.`);
    }
    setDragging(null);
    setDropAt(null);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div>
        <h2 className="text-[17px] font-[650]">Sections</h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-sub">
          The home page, top to bottom.
          {canEdit && ' Drag to reorder, or use Alt with the arrow keys on a section.'}
        </p>
      </div>
      <StatsPeriod />
      {sections.length === 0 ? (
        <p className="text-[13px] text-sub">No sections yet. Add the first one below.</p>
      ) : (
        <ol
          aria-label="Sections on the home page"
          className="relative border-y border-line"
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={onDrop}
        >
          {sections.map((section, index) => (
            <SectionRow
              key={section.id}
              section={section}
              index={index}
              count={sections.length}
              rowRef={(node) => {
                if (node) rows.current.set(section.id, node);
                else rows.current.delete(section.id);
              }}
              dropBefore={dropAt === index}
              dropAfter={dropAt === sections.length && index === sections.length - 1}
              dragging={dragging === section.id}
              onDragStart={() => setDragging(section.id)}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
              onDragOverRow={(after) => setDropAt(after ? index + 1 : index)}
              onOpen={() => select(section.id, { reveal: true })}
              onMove={(by) => move(section.id, by)}
              onHide={() =>
                changeSections((list) =>
                  updateSection(list, section.id, { hidden: !section.hidden }),
                )
              }
              onDuplicate={() => duplicate(section)}
              onDelete={() => remove(section)}
              onAudience={(audience) =>
                changeSections((list) => updateSection(list, section.id, { audience }))
              }
              onDevice={(device) =>
                changeSections((list) => updateSection(list, section.id, { device }))
              }
              canEdit={canEdit}
              name={nameOf(section)}
              detail={sectionTitle(section, theme.schemas[section.type]).detail}
              canDuplicate={!addProblem(theme.schemas, sections, section.type)}
              counts={
                stats
                  ? countsLine(
                      sectionCounts(stats, section.id),
                      theme.reach.subscribe.has(section.type),
                      statsDays,
                    )
                  : null
              }
              testing={isTesting(section)}
              testProblem={testProblem(sections, section.id)}
              onTest={() =>
                isTesting(section) ? select(section.id, { reveal: true }) : test(section)
              }
            />
          ))}
        </ol>
      )}
      <p role="status" className="sr-only">
        {announce}
      </p>
      {canEdit && <AddSection />}
    </div>
  );
}

function SectionRow({
  section,
  index,
  count,
  name,
  detail,
  rowRef,
  dropBefore,
  dropAfter,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onOpen,
  onMove,
  onHide,
  onDuplicate,
  onDelete,
  onAudience,
  onDevice,
  canEdit,
  canDuplicate,
  counts,
  testing,
  testProblem: testBlocked,
  onTest,
}: {
  section: SectionInstance;
  index: number;
  count: number;
  name: string;
  detail: string | null;
  rowRef: (node: HTMLLIElement | null) => void;
  dropBefore: boolean;
  dropAfter: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (after: boolean) => void;
  onOpen: () => void;
  onMove: (by: number) => void;
  onHide: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAudience: (audience: Audience) => void;
  onDevice: (device: Device) => void;
  canEdit: boolean;
  canDuplicate: boolean;
  /** "1,204 reached · 38 signups · 3.2%", once the numbers are in. */
  counts: string | null;
  testing: boolean;
  /** Why a test can't start here, or null. */
  testProblem: string | null;
  onTest: () => void;
}) {
  const notes = [...sectionNotes(section), ...(testing ? ['A/B test running'] : [])];
  const onKeyDown = (event: KeyboardEvent) => {
    if (!canEdit || !event.altKey) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(event.key === 'ArrowUp' ? -1 : 1);
    }
  };
  return (
    <li
      ref={rowRef}
      data-section-row={section.id}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', section.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        onDragOverRow(e.clientY > box.top + box.height / 2);
      }}
      className={`relative flex items-center gap-1 border-b border-line bg-surface pr-1 last:border-b-0 ${
        dragging ? 'opacity-50' : ''
      } ${section.hidden ? 'text-sub' : ''}`}
    >
      {dropBefore && <DropLine where="top" />}
      {dropAfter && <DropLine where="bottom" />}
      {canEdit && (
        <span
          aria-hidden="true"
          title="Drag to move"
          className="grid h-11 w-6 shrink-0 cursor-grab place-items-center text-muted active:cursor-grabbing"
        >
          <Icon.Grip size={16} />
        </span>
      )}
      <button
        type="button"
        data-row-main=""
        onClick={onOpen}
        onKeyDown={onKeyDown}
        aria-keyshortcuts={canEdit ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        aria-label={`${name}${detail ? `: ${detail}` : ''}, ${index + 1} of ${count}${notes.length ? `, ${notes.join(', ')}` : ''}${counts ? `, ${counts.replace(/ · /g, ', ')}` : ''}. Open its settings`}
        className={`flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-control py-1.5 text-left hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple ${canEdit ? 'px-1' : 'px-3'}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">
            {name}
            {detail && <span className="font-normal text-sub">: {detail}</span>}
          </span>
          {notes.length > 0 && (
            <span className="block truncate text-[12.5px] text-sub">{notes.join(' · ')}</span>
          )}
          {counts && (
            <span className="block text-[12.5px] text-sub tabular-nums">{counts}</span>
          )}
        </span>
        <Icon.ChevronRight size={16} className="shrink-0 text-sub" />
      </button>
      {canEdit && (
        <>
          <IconButton
            label={section.hidden ? `Show ${name}` : `Hide ${name}`}
            pressed={!!section.hidden}
            onClick={onHide}
          >
            {section.hidden ? <Icon.EyeOff /> : <Icon.Eye />}
          </IconButton>
          <RowMenu
            name={name}
            section={section}
            first={index === 0}
            last={index === count - 1}
            canDuplicate={canDuplicate}
            onMove={onMove}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onAudience={onAudience}
            onDevice={onDevice}
            testing={testing}
            testProblem={testBlocked}
            onTest={onTest}
          />
        </>
      )}
    </li>
  );
}

function DropLine({ where }: { where: 'top' | 'bottom' }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-purple ${where === 'top' ? '-top-px' : '-bottom-px'}`}
    />
  );
}

function RowMenu({
  name,
  section,
  first,
  last,
  canDuplicate,
  onMove,
  onDuplicate,
  onDelete,
  onAudience,
  onDevice,
  testing,
  testProblem: testBlocked,
  onTest,
}: {
  name: string;
  section: SectionInstance;
  first: boolean;
  last: boolean;
  canDuplicate: boolean;
  onMove: (by: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAudience: (audience: Audience) => void;
  onDevice: (device: Device) => void;
  testing: boolean;
  testProblem: string | null;
  onTest: () => void;
}) {
  const menu = useDisclosure();
  const run =
    (action: () => void, returnFocus = true) =>
    () => {
      menu.close(returnFocus);
      action();
    };
  const audience = section.audience ?? 'everyone';
  const device = section.device ?? 'all';
  return (
    <div className="relative">
      <button
        type="button"
        {...menu.buttonProps}
        aria-label={`More for ${name}`}
        title="More"
        className="grid size-8 place-items-center rounded-[6px] text-sub transition-colors hover:bg-surface-alt hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple"
      >
        <Icon.More />
      </button>
      <div
        {...menu.panelProps}
        role="group"
        aria-label={`${name}: more`}
        className="line-menu absolute top-[calc(100%+4px)] right-0 w-[260px]"
      >
        <button
          type="button"
          className="line-menu-item"
          disabled={first}
          onClick={run(() => onMove(-1), false)}
        >
          Move up
        </button>
        <button
          type="button"
          className="line-menu-item"
          disabled={last}
          onClick={run(() => onMove(1), false)}
        >
          Move down
        </button>
        <button
          type="button"
          className="line-menu-item"
          disabled={!canDuplicate}
          onClick={run(onDuplicate, false)}
          title={canDuplicate ? undefined : 'This page has as many of these as the theme allows'}
        >
          <Icon.Duplicate size={16} className="text-sub" /> Duplicate
        </button>
        {testing ? (
          <button type="button" className="line-menu-item" onClick={run(onTest, false)}>
            <Icon.Sliders size={16} className="text-sub" /> See the A/B test
          </button>
        ) : (
          <button
            type="button"
            className="line-menu-item items-start"
            disabled={!!testBlocked}
            onClick={run(onTest, false)}
          >
            <Icon.Sliders size={16} className="mt-0.5 text-sub" />
            <span className="min-w-0">
              Test a variant
              <small className="block text-[13px] leading-snug text-sub">
                {testBlocked ?? 'Shows a second version to half the views.'}
              </small>
            </span>
          </button>
        )}
        <button
          type="button"
          className="line-menu-item text-danger!"
          onClick={run(onDelete, false)}
        >
          <Icon.Close size={16} /> Delete
        </button>
        <MenuChoices
          legend="Who sees it"
          options={AUDIENCES}
          value={audience}
          onChange={(v) => onAudience(v)}
        />
        <MenuChoices
          legend="Where"
          options={DEVICES}
          value={device}
          onChange={(v) => onDevice(v)}
        />
      </div>
    </div>
  );
}

function MenuChoices<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="mt-1 border-t border-line pt-1">
      <p id={id} className="px-2.5 pt-1.5 pb-1 text-[13px] font-semibold text-sub">
        {legend}
      </p>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="line-menu-item justify-between"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {value === option.value && <Icon.Check size={16} className="text-ink" />}
        </button>
      ))}
    </div>
  );
}

function AddSection() {
  const { draft, sections, select } = useStudio();
  const changeSections = useSectionChange();
  const menu = useDisclosure();
  const theme = draft.theme;
  if (!theme) return null;
  const types = Object.entries(theme.schemas).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const add = (type: string) => {
    const { added } = addSection(sections, type);
    changeSections((list) => addSection(list, type).sections);
    menu.close();
    select(added.id, { reveal: true });
  };
  return (
    <div className="relative">
      <button type="button" {...menu.buttonProps} className="btn-ghost">
        <Icon.Plus size={18} /> Add section
      </button>
      <div
        {...menu.panelProps}
        role="group"
        aria-label="Sections you can add"
        className="line-menu absolute top-[calc(100%+6px)] left-0 max-h-[min(460px,70vh)] w-[min(340px,calc(100vw-32px))] overflow-y-auto"
      >
        <p className="px-2.5 pt-1.5 pb-1 text-[13px] text-sub">Adds it at the end of the page</p>
        {types.map(([type, schema]) => {
          const problem = addProblem(theme.schemas, sections, type);
          return (
            <button
              key={type}
              type="button"
              className="line-menu-item items-start"
              disabled={!!problem}
              onClick={() => add(type)}
            >
              <span className="min-w-0">
                {schema.name}
                <small className="block text-[13px] leading-snug text-sub">
                  {problem ?? schema.description ?? 'A section of this theme.'}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionSettings({
  section,
  variant,
  onVariant,
}: {
  section: SectionInstance;
  /** Which variant the form edits: B only while a test runs. */
  variant: Variant;
  onVariant: (variant: Variant) => void;
}) {
  const { draft, channelId, canEdit, select, sections } = useStudio();
  const changeSections = useSectionChange();
  const toast = useToast();
  const back = useRef<HTMLButtonElement>(null);
  const theme = draft.theme;
  const schema = theme?.schemas[section.type];
  const { name } = sectionTitle(section, schema);
  const defs = schema?.settings ?? [];
  const editingB = variant === 'b' && isTesting(section);
  const values = resolveSettings(defs, editingB ? section.experiment?.variantB : section.settings);
  const experiment = section.experiment;

  const end = (winner: Variant) => {
    const before: Design = draft.design;
    changeSections((list) => endTest(list, section.id, winner));
    onVariant('a');
    toast.show({
      message:
        winner === 'b'
          ? `Test ended: B is now ${name}’s settings. Publish to put it live.`
          : `Test ended: ${name} keeps A. Publish to stop showing B.`,
      action: { label: 'Undo', onAction: () => draft.change(() => before) },
    });
  };
  const index = sections.findIndex((s) => s.id === section.id);
  const audienceName = useId();
  const deviceName = useId();

  useEffect(() => {
    back.current?.focus();
  }, [section.id]);

  const close = () => {
    select(null);
    // Back on the list, focus goes to the row that was open.
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-section-row="${section.id}"] [data-row-main]`)
        ?.focus(),
    );
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Esc goes back to the list, from any field
    <div
      className="grid grid-cols-[minmax(0,1fr)] gap-6"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <button
          ref={back}
          type="button"
          onClick={close}
          className="inline-flex w-fit items-center gap-1 rounded-control text-[13px] font-semibold text-sub hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
        >
          <Icon.ChevronLeft size={16} /> All sections
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-[650]">{name}</h2>
            <p className="mt-0.5 text-[13px] text-sub">
              Section {index + 1} of {sections.length}
              {schema?.description ? ` · ${schema.description}` : ''}
            </p>
          </div>
          {canEdit && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                const before: Design = draft.design;
                changeSections((list) => removeSection(list, section.id).sections);
                select(null);
                toast.show({
                  message: `${name} deleted.`,
                  action: { label: 'Undo', onAction: () => draft.change(() => before) },
                });
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {!schema && (
        <p className="rounded-control bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
          This theme has no “{section.type}” section, so it won’t show. Delete it, or add sections/
          {section.type}.html in Code.
        </p>
      )}

      <section
        aria-label="Where it shows"
        className="grid grid-cols-[minmax(0,1fr)] gap-4 border-b border-line pb-6"
      >
        <ShowChoices
          legend="Who sees it"
          name={audienceName}
          options={AUDIENCES}
          value={section.audience ?? 'everyone'}
          disabled={!canEdit}
          onChange={(audience) =>
            changeSections((list) => updateSection(list, section.id, { audience }))
          }
        />
        <ShowChoices
          legend="Where"
          name={deviceName}
          options={DEVICES}
          value={section.device ?? 'all'}
          disabled={!canEdit}
          onChange={(device) =>
            changeSections((list) => updateSection(list, section.id, { device }))
          }
        />
        <Checkbox
          label="Hide this section"
          hint="Kept with its settings, not shown."
          checked={!!section.hidden}
          disabled={!canEdit}
          onChange={(hidden) =>
            changeSections((list) => updateSection(list, section.id, { hidden }))
          }
        />
      </section>

      {experiment && (
        <TestResults
          section={section}
          experiment={experiment}
          hasForm={!!theme?.reach.subscribe.has(section.type)}
          onEnd={end}
        />
      )}

      {isTesting(section) && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <VariantSwitch value={variant} onChange={onVariant} />
          <p className="text-[13px] text-sub">
            {editingB
              ? 'Changes here go to variant B. The preview shows B.'
              : 'Changes here go to A, what half the views see.'}
          </p>
        </div>
      )}

      {defs.length === 0 ? (
        <p className="text-[13px] text-sub">This section has no settings of its own.</p>
      ) : (
        <SettingsForm
          // Each variant's controls start from its own values.
          key={editingB ? 'b' : 'a'}
          defs={defs}
          values={values}
          context={{ channelId, disabled: !canEdit }}
          onChange={(id, value) =>
            changeSections((list) =>
              withVariantSettings(list, section.id, editingB ? 'b' : 'a', (settings) =>
                withValue(settings, id, value),
              ),
            )
          }
        />
      )}
    </div>
  );
}

function ShowChoices<T extends string>({
  legend,
  name,
  options,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  options: { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="grid grid-cols-[minmax(0,1fr)] gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-[13px] font-semibold">{legend}</legend>
      <div className="flex rounded-control border border-line bg-surface-alt p-[3px]">
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              className={`inline-flex min-h-[30px] flex-1 cursor-pointer items-center justify-center rounded-[6px] px-2 text-center text-[13px] transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
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
    </fieldset>
  );
}
