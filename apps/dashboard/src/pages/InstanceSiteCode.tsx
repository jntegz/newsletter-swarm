// Settings → Instance: where code owners add to their website may run (0065_site_code_rules.sql).
// On a publication's own domain it always runs. On this Swarm's own domain every publication
// shares the owner's name, so there it runs only for the workspaces chosen here.
import type { InstanceSiteCodeWorkspace } from '@swarm/domain';
import { ErrorNotice, LoadingRows, Switch, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  instanceSiteCodeQuery,
  useSaveInstanceSiteCode,
  type SaveInstanceSiteCode,
} from '../api/instance';

const SEARCH_FROM = 8;

/**
 * Only the switch lets code run. An owner seat of an instance admin is shown, but allows nothing:
 * any owner can make a teammate an owner.
 */
function WorkspaceRow({ workspace }: { workspace: InstanceSiteCodeWorkspace }) {
  const save = useSaveInstanceSiteCode();
  const pending = save.isPending
    ? (save.variables as Extract<SaveInstanceSiteCode, { allowed: boolean }>).allowed
    : undefined;
  return (
    <li className="border-t border-line py-3.5">
      <Switch
        label={workspace.name}
        hint={
          workspace.held
            ? 'Its code was waiting when every workspace was allowed, so it stays off until you allow it here.'
            : workspace.ownedByInstanceAdmin
              ? 'An instance admin is an owner here. Code runs only while this is on.'
              : undefined
        }
        checked={pending ?? workspace.allowed}
        loading={save.isPending}
        error={save.error ? `Not saved. ${save.error.message}` : undefined}
        onChange={(allowed) => save.mutate({ workspaceId: workspace.id, allowed })}
      />
    </li>
  );
}

export function InstanceSiteCode() {
  const rules = useQuery(instanceSiteCodeQuery);
  const save = useSaveInstanceSiteCode();
  const [search, setSearch] = useState('');
  const saving =
    save.isPending && 'everyWorkspace' in save.variables
      ? save.variables.everyWorkspace
      : undefined;
  const workspaces = (rules.data?.workspaces ?? []).filter((w) =>
    w.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <section aria-labelledby="site-code-title" className="grid max-w-[560px] gap-5">
      <div>
        <h2 id="site-code-title" className="text-[16px] font-semibold">
          Code on websites
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Publications can add analytics and other scripts to their website. On their own domain
          that code always runs. On this Swarm’s own domain every publication shares your name, so a
          script or a fake sign-in page there could get your domain blocked, along with your
          dashboard and your email. Code there runs only for the workspaces you allow below. A
          workspace an instance admin makes is allowed when it is made; anyone else’s is not, even
          after they make you an owner of it. Saved code that is not allowed is kept, and its owners
          see why it does not run.
        </p>
      </div>
      {rules.isPending && <LoadingRows label="Loading code rules" rows={3} />}
      {rules.error && <ErrorNotice message={rules.error.message} />}
      {rules.data && (
        <>
          <Switch
            label="Let every workspace add code to websites on this Swarm’s domain"
            hint="Off is safest when people you don’t know can make a workspace here."
            checked={saving ?? rules.data.everyWorkspace}
            loading={saving !== undefined}
            error={save.error ? `Not saved. ${save.error.message}` : undefined}
            onChange={(everyWorkspace) => save.mutate({ everyWorkspace })}
          />
          {rules.data.everyWorkspace && rules.data.workspaces.some((w) => w.held) && (
            <div>
              <h3 className="text-[14px] font-semibold">Code still waiting for you</h3>
              <p className="mt-1 text-[13px] text-sub">
                These workspaces had code that wasn’t allowed when you let every workspace add code.
                It stays off until you look at it and allow the workspace here.
              </p>
              <ul className="mt-2.5 border-b border-line">
                {rules.data.workspaces
                  .filter((w) => w.held)
                  .map((workspace) => (
                    <WorkspaceRow key={workspace.id} workspace={workspace} />
                  ))}
              </ul>
            </div>
          )}
          {!rules.data.everyWorkspace && (
            <div>
              <h3 className="text-[14px] font-semibold">Allowed workspaces</h3>
              {rules.data.workspaces.length >= SEARCH_FROM && (
                <div className="mt-2.5">
                  <TextField
                    label="Find a workspace"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              )}
              {workspaces.length ? (
                <ul className="mt-2.5 border-b border-line">
                  {workspaces.map((workspace) => (
                    <WorkspaceRow key={workspace.id} workspace={workspace} />
                  ))}
                </ul>
              ) : (
                <p className="mt-2.5 text-[13px] text-sub">No workspace has that name.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
