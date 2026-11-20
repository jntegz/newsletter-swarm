// The nested rule editor: groups (All / Any / None) of conditions and further groups.
import type { CircleComparator, CircleGroup, CircleLeaf, CircleRule } from '@swarm/domain';
import { Button } from '@swarm/ui/components';
import { useId, useState, type ReactNode } from 'react';
import * as Icon from '../icons';
import {
  MAX_CONDITIONS,
  MAX_DAYS,
  MAX_DEPTH,
  addChild,
  canAdd,
  changeComparator,
  changeField,
  choiceName,
  comparatorLabel,
  comparatorsFor,
  errorKey,
  findField,
  isGroup,
  measure,
  moveNode,
  newCondition,
  parseList,
  removeNode,
  setGroupOp,
  updateNode,
  valueInput,
  type FieldSpec,
  type NodePath,
} from './rules';

const CONTROL =
  'h-10 rounded-control border bg-surface px-3 text-[13.5px] text-ink hover:border-line-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple disabled:bg-surface-alt disabled:text-sub';
const border = (invalid: boolean) => (invalid ? 'border-danger' : 'border-line-control');

const OPS: { value: CircleGroup['op']; label: string }[] = [
  { value: 'and', label: 'all' },
  { value: 'or', label: 'any' },
  { value: 'not', label: 'none' },
];
const JOINER: Record<CircleGroup['op'], string> = { and: 'and', or: 'or', not: '' };
const GROUP_ORDER: FieldSpec['group'][] = [
  'Subscriber',
  'Tags',
  'Engagement',
  'Source',
  'Profile fields',
  'Segments and paid plans',
];

interface EditorProps {
  root: CircleGroup;
  onChange: (root: CircleGroup) => void;
  catalogue: readonly FieldSpec[];
  /** Keyed by errorKey(node, slot). */
  errors: Record<string, string>;
  readOnly?: boolean | undefined;
}

/** Labels a node for screen readers: "Condition 2.1" or "Group 3". */
const nodeName = (path: NodePath, group: boolean) =>
  `${group ? 'Group' : 'Condition'} ${path.map((i) => i + 1).join('.')}`;

export function RuleEditor({ root, onChange, catalogue, errors, readOnly = false }: EditorProps) {
  const { conditions, depth } = measure(root);
  const rootError = errors[errorKey([], '')];
  return (
    <div className="grid gap-3">
      <GroupEditor
        node={root}
        path={[]}
        root={root}
        onChange={onChange}
        catalogue={catalogue}
        errors={errors}
        readOnly={readOnly}
      />
      {rootError && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {rootError}
        </p>
      )}
      <p className="tabular text-[12px] text-sub">
        {conditions} of {MAX_CONDITIONS} conditions
        {depth > 2 && ` · nested ${depth - 1} of ${MAX_DEPTH - 1} levels deep`}
      </p>
    </div>
  );
}

function GroupEditor({
  node,
  path,
  root,
  onChange,
  catalogue,
  errors,
  readOnly,
}: EditorProps & { node: CircleGroup; path: NodePath; root: CircleGroup }) {
  const opId = useId();
  const childrenError = errors[errorKey(path, 'children')];
  const groupError = path.length ? errors[errorKey(path, '')] : undefined;
  const errorId = `${opId}-error`;
  const room = canAdd(root, path);
  const isRoot = path.length === 0;
  const name = isRoot ? 'Rule' : nodeName(path, true);
  const add = (child: CircleRule) => onChange(addChild(root, path, child));

  return (
    <div
      role="group"
      aria-label={name}
      aria-describedby={childrenError || groupError ? errorId : undefined}
      className={`grid gap-3 rounded-card-app border p-3 sm:p-4 ${
        isRoot ? 'border-line bg-surface' : 'bg-surface-alt'
      } ${childrenError || groupError ? 'border-danger' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          <label htmlFor={opId}>{isRoot ? 'Subscribers who match' : 'Match'}</label>
          <select
            id={opId}
            className={`${CONTROL} ${border(false)}`}
            value={node.op}
            disabled={readOnly}
            onChange={(e) => onChange(setGroupOp(root, path, e.target.value as CircleGroup['op']))}
          >
            {OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          <span>of these</span>
        </div>
        {!isRoot && !readOnly && (
          <NodeActions path={path} root={root} onChange={onChange} name={name} />
        )}
      </div>

      {node.children.length > 0 && (
        <ol className="grid gap-2">
          {node.children.map((child, index) => {
            const childPath = [...path, index];
            return (
              <li key={index} className="grid gap-2">
                {index > 0 && JOINER[node.op] && (
                  <span aria-hidden="true" className="table-head pl-1">
                    {JOINER[node.op]}
                  </span>
                )}
                {isGroup(child) ? (
                  <GroupEditor
                    node={child}
                    path={childPath}
                    root={root}
                    onChange={onChange}
                    catalogue={catalogue}
                    errors={errors}
                    readOnly={readOnly}
                  />
                ) : (
                  <ConditionEditor
                    leaf={child}
                    path={childPath}
                    root={root}
                    onChange={onChange}
                    catalogue={catalogue}
                    errors={errors}
                    readOnly={readOnly}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(childrenError || groupError) && (
        <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
          {childrenError ?? groupError}
        </p>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!room.condition}
            aria-label={isRoot ? 'Add condition' : `Add condition to ${name.toLowerCase()}`}
            onClick={() => add(newCondition(catalogue))}
          >
            <Icon.Plus size={14} />
            Add condition
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={!room.group}
            aria-label={isRoot ? 'Add group' : `Add group to ${name.toLowerCase()}`}
            onClick={() => add({ op: 'or', children: [newCondition(catalogue)] })}
          >
            <Icon.Plus size={14} />
            Add group
          </Button>
          {node.op === 'not' && (
            <span className="text-[12px] text-sub">
              “None” holds one condition or group; more go into an “any” group inside it.
            </span>
          )}
          {!room.condition && measure(root).conditions >= MAX_CONDITIONS && (
            <span className="text-[12px] text-sub">
              Segments hold up to {MAX_CONDITIONS} conditions.
            </span>
          )}
          {room.condition && !room.group && (
            <span className="text-[12px] text-sub">Groups can’t nest any deeper here.</span>
          )}
        </div>
      )}
    </div>
  );
}

function NodeActions({
  path,
  root,
  onChange,
  name,
}: {
  path: NodePath;
  root: CircleGroup;
  onChange: (root: CircleGroup) => void;
  name: string;
}) {
  const index = path.at(-1) ?? 0;
  const parent = path.slice(0, -1);
  let siblings = 0;
  let node: CircleRule = root;
  for (const i of parent) node = (node as CircleGroup).children[i] as CircleRule;
  if (isGroup(node)) siblings = node.children.length;
  return (
    <div className="flex items-center gap-1">
      {siblings > 1 && (
        <>
          <IconButton
            label={`Move ${name.toLowerCase()} up`}
            disabled={index === 0}
            onClick={() => onChange(moveNode(root, path, -1))}
          >
            <span aria-hidden="true">↑</span>
          </IconButton>
          <IconButton
            label={`Move ${name.toLowerCase()} down`}
            disabled={index >= siblings - 1}
            onClick={() => onChange(moveNode(root, path, 1))}
          >
            <span aria-hidden="true">↓</span>
          </IconButton>
        </>
      )}
      <IconButton
        label={`Remove ${name.toLowerCase()}`}
        onClick={() => onChange(removeNode(root, path))}
      >
        <Icon.Close size={14} />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-10 place-items-center rounded-control text-sub hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ConditionEditor({
  leaf,
  path,
  root,
  onChange,
  catalogue,
  errors,
  readOnly,
}: EditorProps & { leaf: CircleLeaf; path: NodePath; root: CircleGroup }) {
  const id = useId();
  const name = nodeName(path, false);
  const spec = findField(catalogue, leaf.field);
  const cmps = comparatorsFor(spec);
  const input = valueInput(spec, leaf.cmp);
  const set = (next: CircleLeaf) => onChange(updateNode(root, path, () => next));
  const fieldError = errors[errorKey(path, 'field')];
  const cmpError = errors[errorKey(path, 'cmp')];
  const valueError = errors[errorKey(path, 'value')];
  const nodeError = errors[errorKey(path, '')];
  const messages = [fieldError, cmpError, valueError, nodeError].filter(Boolean);
  const errorId = `${id}-error`;
  const describe = (error: string | undefined) => (error ? errorId : undefined);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    specs: catalogue.filter((s) => s.group === group),
  })).filter((g) => g.specs.length > 0);

  return (
    <div
      role="group"
      aria-label={name}
      className={`grid gap-2 rounded-card-app border bg-surface p-2.5 ${
        messages.length ? 'border-danger' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <select
          aria-label={`${name}: field`}
          aria-invalid={!!fieldError || undefined}
          aria-describedby={describe(fieldError)}
          className={`${CONTROL} ${border(!!fieldError)} min-w-0 flex-[1_1_11rem]`}
          value={leaf.field}
          disabled={readOnly}
          onChange={(e) => set(changeField(leaf, catalogue, e.target.value))}
        >
          {!spec && (
            <option value={leaf.field}>{leaf.field.replace(/^field:/, '')} (missing)</option>
          )}
          {groups.map(({ group, specs }) => (
            <optgroup key={group} label={group}>
              {specs.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                  {s.encrypted ? ' (encrypted)' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          aria-label={`${name}: comparison`}
          aria-invalid={!!cmpError || undefined}
          aria-describedby={describe(cmpError)}
          className={`${CONTROL} ${border(!!cmpError)} min-w-0 flex-[1_1_9rem]`}
          value={leaf.cmp}
          disabled={readOnly || !spec}
          onChange={(e) =>
            set(changeComparator(leaf, catalogue, e.target.value as CircleComparator))
          }
        >
          {!cmps.includes(leaf.cmp) && <option value={leaf.cmp}>{leaf.cmp}</option>}
          {cmps.map((cmp) => (
            <option key={cmp} value={cmp}>
              {comparatorLabel(spec, cmp)}
            </option>
          ))}
        </select>
        {input !== 'none' && (
          <div className="min-w-0 flex-[2_1_12rem]">
            <ValueEditor
              key={`${leaf.field}-${input}`}
              leaf={leaf}
              spec={spec}
              input={input}
              label={`${name}: value`}
              invalid={!!valueError}
              describedBy={describe(valueError)}
              readOnly={!!readOnly}
              onChange={(value) =>
                set(value === undefined ? { field: leaf.field, cmp: leaf.cmp } : { ...leaf, value })
              }
            />
          </div>
        )}
        {!readOnly && <NodeActions path={path} root={root} onChange={onChange} name={name} />}
      </div>
      {spec?.encrypted && (
        <p className="text-[12px] text-sub">
          This field is encrypted, so a segment can only check whether it is set.
        </p>
      )}
      {messages.length > 0 && (
        <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
          {messages.join(' ')}
        </p>
      )}
    </div>
  );
}

function ValueEditor({
  leaf,
  spec,
  input,
  label,
  invalid,
  describedBy,
  readOnly,
  onChange,
}: {
  leaf: CircleLeaf;
  spec: FieldSpec | undefined;
  input: ReturnType<typeof valueInput>;
  label: string;
  invalid: boolean;
  describedBy: string | undefined;
  readOnly: boolean;
  onChange: (value: CircleLeaf['value']) => void;
}) {
  const common = {
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    disabled: readOnly,
    className: `${CONTROL} ${border(invalid)} w-full`,
  };
  const value = leaf.value;
  const toNumber = (text: string) => (text.trim() === '' ? null : Number(text));

  switch (input) {
    case 'text':
      return (
        <input
          type="text"
          {...common}
          maxLength={500}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          inputMode="decimal"
          step="any"
          {...common}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(toNumber(e.target.value))}
        />
      );
    case 'count':
      return (
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          {...common}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(toNumber(e.target.value))}
        />
      );
    case 'days':
      return (
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_DAYS}
            step={1}
            {...common}
            className={`${common.className} max-w-28`}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(toNumber(e.target.value))}
          />
          <span className="text-[13.5px] text-sub">days</span>
        </div>
      );
    case 'date':
      return (
        <input
          type="date"
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'boolean':
      return (
        <select
          {...common}
          value={value === false ? 'no' : 'yes'}
          onChange={(e) => onChange(e.target.value === 'yes')}
        >
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case 'choice': {
      const choices = spec?.choices ?? [];
      const current = typeof value === 'string' ? value : '';
      return (
        <select {...common} value={current} onChange={(e) => onChange(e.target.value)}>
          {current && !choices.includes(current) && <option value={current}>{current}</option>}
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choiceName(spec, choice)}
            </option>
          ))}
        </select>
      );
    }
    case 'choice-list':
      return (
        <ChoiceList
          label={label}
          spec={spec}
          choices={spec?.choices ?? []}
          value={Array.isArray(value) ? value.map(String) : []}
          invalid={invalid}
          describedBy={describedBy}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'text-list':
      return (
        <ListInput
          common={common}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

/** Free text, comma-separated. Keeps what is typed (a trailing comma, say) while it parses. */
function ListInput({
  common,
  value,
  onChange,
}: {
  common: Record<string, unknown>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(', '));
  // When the value changes from outside (a condition moved or removed), show it instead.
  const same = JSON.stringify(parseList(draft)) === JSON.stringify(value);
  const shown = same ? draft : value.join(', ');
  return (
    <input
      type="text"
      {...common}
      placeholder="Separate values with commas"
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

function ChoiceList({
  label,
  spec,
  choices,
  value,
  invalid,
  describedBy,
  readOnly,
  onChange,
}: {
  label: string;
  spec: FieldSpec | undefined;
  choices: readonly string[];
  value: string[];
  invalid: boolean;
  describedBy: string | undefined;
  readOnly: boolean;
  onChange: (value: string[]) => void;
}) {
  // Values no longer offered (a deleted tag, say) stay visible so they can be unticked.
  const all = [...choices, ...value.filter((v) => !choices.includes(v))];
  return (
    <fieldset
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={`max-h-40 overflow-y-auto rounded-control border bg-surface px-2 py-1.5 ${border(invalid)}`}
    >
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {all.map((choice) => (
          <label key={choice} className="flex min-h-8 items-center gap-1.5 text-[13.5px]">
            <input
              type="checkbox"
              className="size-4 accent-purple"
              disabled={readOnly}
              checked={value.includes(choice)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, choice] : value.filter((v) => v !== choice))
              }
            />
            {choiceName(spec, choice)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
