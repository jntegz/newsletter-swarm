// What a page shows when it fails to render or load, and when its address matches no page. The
// router puts these in the failing route's place, so the rail and the top bar stay usable.
import { useQueryClient, useQueryErrorResetBoundary } from '@tanstack/react-query';
import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';

/** Reports a page that failed. The browser console is where it goes for now. */
export function reportRouteError(error: unknown) {
  console.error('A dashboard page failed to load.', error);
}

function Problem({
  title,
  children,
  actions,
}: {
  title: string;
  children: string;
  actions: ReactNode;
}) {
  return (
    <div className="max-w-[60ch]">
      <h1 className="page-title">{title}</h1>
      <p className="mt-2 text-[15px] text-sub">{children}</p>
      <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

/**
 * The router's default error component. "Try again" drops the data the failed page had loaded
 * (only queries nothing on screen still uses, so the shell's stay) and renders the page again.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryReset = useQueryErrorResetBoundary();
  useEffect(() => reportRouteError(error), [error]);

  const retry = () => {
    queryClient.removeQueries({ type: 'inactive' });
    queryReset.reset();
    reset();
    void router.invalidate();
  };

  return (
    <Problem
      title="This page didn’t load"
      actions={
        <>
          <button type="button" className="btn-primary btn-sm" onClick={retry}>
            Try again
          </button>
          <Link to="/" className="btn-ghost btn-sm">
            Go to Home
          </Link>
        </>
      }
    >
      Something went wrong while showing it. Nothing you saved is lost. Try again, or go to Home and
      come back to it.
    </Problem>
  );
}

/** For an address inside the app that matches no page. */
export function RouteNotFound() {
  return (
    <Problem
      title="Page not found"
      actions={
        <Link to="/" className="btn-primary btn-sm">
          Go to Home
        </Link>
      }
    >
      The address may be mistyped, or the page has moved.
    </Problem>
  );
}
