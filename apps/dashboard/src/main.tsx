import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, onUnauthorized } from './api/client';
import { keys } from './api/queries';
import { createAppRouter } from './router';
import './index.css';
import { installMockApi } from './dev/mockApi';

// Development only: ?mock=1 answers the API with canned data (see ./dev/mockApi.ts).
if (import.meta.env.DEV) installMockApi();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Do not retry answers the server meant: missing, forbidden, invalid.
      retry: (count, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});
const router = createAppRouter(queryClient);

const PUBLIC = ['/sign-in', '/invite'];

// A session that expires mid-use sends the operator to sign in and back afterwards; one that
// still owes a second factor (mfa_required) goes to the second-factor step instead.
onUnauthorized((code) => {
  const { pathname, href } = router.state.location;
  if (PUBLIC.some((path) => pathname.startsWith(path))) return;
  void queryClient.invalidateQueries({ queryKey: keys.me });
  if (code === 'mfa_required') {
    void router.navigate({ to: '/sign-in/verify', search: { return: href } });
    return;
  }
  queryClient.removeQueries({ queryKey: keys.me });
  void router.navigate({ to: '/sign-in', search: { return: href } });
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
