// The access list shared by API keys and OAuth apps: one row per resource, each a set of radios.
import { API_SCOPES, type ApiScope } from '@swarm/domain';
import { useId } from 'react';

export const RESOURCE_LABEL: Record<string, string> = {
  channels: 'Publications',
  members: 'Subscribers',
  dispatches: 'Posts',
  broadcasts: 'Sends',
  circles: 'Segments',
  fields: 'Profile fields',
  levels: 'Paid plans',
  forms: 'Signup forms',
  flows: 'Automations',
  webhooks: 'Webhooks',
  sends: 'Direct sends',
  imports: 'Imports',
  audit: 'Audit log',
  rosters: 'Rosters',
  goods: 'Products',
};

type Access = 'none' | 'read' | 'write';
export type AccessMap = Record<string, Access>;

/** One row per resource, with the access levels its scopes offer. */
const RESOURCES = Object.entries(
  API_SCOPES.reduce<Record<string, Partial<Record<'read' | 'write', ApiScope>>>>((acc, scope) => {
    const [resource = '', level] = scope.split(':') as [string, 'read' | 'write'];
    acc[resource] = { ...acc[resource], [level]: scope };
    return acc;
  }, {}),
).map(([resource, levels]) => ({ resource, label: RESOURCE_LABEL[resource] ?? resource, levels }));

/** The smallest set of scopes for this access: a write scope also grants its read scope. */
export function scopesOf(access: AccessMap): ApiScope[] {
  return RESOURCES.flatMap(({ resource, levels }) => {
    const chosen = access[resource] ?? 'none';
    const scope = chosen === 'none' ? undefined : levels[chosen];
    return scope ? [scope] : [];
  });
}

/** Every scope this access covers, for a list that is matched exactly, as an OAuth app's is. */
export function allScopesOf(access: AccessMap): ApiScope[] {
  return RESOURCES.flatMap(({ resource, levels }) => {
    const chosen = access[resource] ?? 'none';
    if (chosen === 'none') return [];
    const covered = chosen === 'write' ? [levels.read, levels.write] : [levels.read];
    return covered.filter((scope): scope is ApiScope => !!scope);
  });
}

export function accessOf(scopes: readonly ApiScope[]): AccessMap {
  const access: AccessMap = {};
  for (const scope of scopes) {
    const [resource = '', level] = scope.split(':') as [string, 'read' | 'write'];
    if (level === 'write' || !access[resource]) access[resource] = level;
  }
  return access;
}

// Fixed widths, so the options line up from row to row even where a resource has no write level.
const OPTION_WIDTH: Record<Access, string> = {
  none: 'w-[76px]',
  read: 'w-[50px]',
  write: 'w-[108px]',
};

const OPTION_LABEL: Record<Access, string> = {
  none: 'No access',
  read: 'Read',
  write: 'Read and write',
};

export function ScopePicker({
  value,
  onChange,
}: {
  value: AccessMap;
  onChange: (next: AccessMap) => void;
}) {
  const id = useId();
  return (
    <ul className="divide-y divide-line rounded-control border border-line-app">
      {RESOURCES.map(({ resource, label, levels }) => {
        const labelId = `${id}-${resource}`;
        const chosen = value[resource] ?? 'none';
        const options = (['none', 'read', 'write'] as const).filter(
          (level) => level === 'none' || levels[level],
        );
        return (
          <li
            key={resource}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 pr-1.5 pl-3"
          >
            <span id={labelId} className="text-[13.5px]">
              {label}
            </span>
            <div
              role="radiogroup"
              aria-labelledby={labelId}
              className="flex w-[234px] max-w-full gap-0"
            >
              {options.map((level) => (
                <label key={level} className={`${OPTION_WIDTH[level]} cursor-pointer`}>
                  <input
                    type="radio"
                    name={labelId}
                    value={level}
                    checked={chosen === level}
                    onChange={() => onChange({ ...value, [resource]: level })}
                    className="peer sr-only"
                  />
                  <span
                    className={`block rounded-[6px] py-1 text-center text-[12.5px] whitespace-nowrap text-sub transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-purple hover:bg-surface-alt hover:text-ink ${
                      level === 'none'
                        ? 'peer-checked:bg-surface-alt peer-checked:text-ink'
                        : 'peer-checked:bg-purple peer-checked:font-semibold peer-checked:text-white peer-checked:hover:bg-purple'
                    }`}
                  >
                    {OPTION_LABEL[level]}
                  </span>
                </label>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
