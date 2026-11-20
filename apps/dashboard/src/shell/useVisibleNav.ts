import { useMemo } from 'react';
import { useWorkspaceFlag } from '../channel';
import { visibleNav, type NavGroup } from './nav';

/** The rail's groups for this workspace, for the rail and the command menu alike. */
export function useVisibleNav(): NavGroup[] {
  // Apps holds the directory, Shorthop and DeBounce, so any one of them shows it.
  const directoryOn = useWorkspaceFlag('app_directory') === true;
  const applicationsOn = useWorkspaceFlag('applications') === true;
  const checksOn = useWorkspaceFlag('email_verification') === true;
  const appsOn = directoryOn || applicationsOn || checksOn;
  return useMemo(() => visibleNav((flag) => flag === 'app_directory' && appsOn), [appsOn]);
}
