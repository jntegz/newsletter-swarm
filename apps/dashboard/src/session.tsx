import type { Me, SeatRole, Workspace } from '@swarm/domain';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { meQuery } from './api/queries';

interface SessionValue {
  me: Me;
  workspace: Workspace;
  setWorkspaceId: (id: string) => void;
  can: (minimum: SeatRole) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_KEY = 'swarm:workspace';
const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The signed-in operator and the workspace they are working in. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { data: me } = useSuspenseQuery(meQuery);
  const [selected, setSelected] = useState<string | null>(readStored);

  const value = useMemo<SessionValue>(() => {
    const workspace = me.workspaces.find((w) => w.id === selected) ?? me.workspaces[0];
    if (!workspace) throw new Error('Signed in without a workspace');
    return {
      me,
      workspace,
      setWorkspaceId: (id) => {
        setSelected(id);
        try {
          window.localStorage.setItem(STORAGE_KEY, id);
        } catch {
          // Storage can be blocked; the choice then lasts for this tab only.
        }
      },
      can: (minimum) => RANK[workspace.role] >= RANK[minimum],
    };
  }, [me, selected]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() outside SessionProvider');
  return value;
}

export const ROLE_LABEL: Record<SeatRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  author: 'Author',
  viewer: 'Viewer',
};
