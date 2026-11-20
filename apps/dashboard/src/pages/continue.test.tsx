// The page an emailed sign-in link opens. Anyone can send a link to their own account to someone
// else, so the page names the account, says when continuing replaces the one signed in here, and
// then goes home rather than to the return path whoever sent the link chose.
import type { Me } from '@swarm/domain';
import type * as Components from '@swarm/ui/components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Client from '../api/client';
import { ApiError } from '../api/client';
import { keys } from '../api/queries';
import { ContinuePage } from './Auth';

const navigate = vi.fn();
const post = vi.fn();
let pressContinue: (() => void) | undefined;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => navigate,
}));

vi.mock('@swarm/ui/components', async (actual) => ({
  ...(await actual<typeof Components>()),
  // A static render has no clicks, so the test keeps the Continue handler to call it.
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    pressContinue = onClick;
    return <button type="button">{children}</button>;
  },
}));

vi.mock('../api/client', async (actual) => ({
  ...(await actual<typeof Client>()),
  api: { post: (path: string, body: unknown) => post(path, body) },
}));

const TOKEN = 'tok_0123456789abcdefghij';
const SENDER = 'sender@example.com';

const me = (email: string, secondFactor: Me['secondFactor'] = undefined): Me => ({
  operator: { id: 'op_1', email, name: null, createdAt: '2026-11-01T00:00:00.000Z' },
  workspaces: [],
  sessionId: 'se_1',
  ...(secondFactor ? { secondFactor } : {}),
  instanceAdmin: false,
});

/** The page for a link to SENDER's account, with this browser's session as `current`. */
function render(current: Me | ApiError) {
  // A static render runs no fetches: an answer already in the cache stands for one that came back.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  client.setQueryData(['quickpass', TOKEN], { email: SENDER });
  if (current instanceof ApiError) {
    client
      .getQueryCache()
      .build(client, { queryKey: keys.me })
      .setState({ status: 'error', error: current });
  } else {
    client.setQueryData(keys.me, current);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ContinuePage returnTo="/chosen-by-sender" />
    </QueryClientProvider>,
  );
}

async function continueSignIn() {
  expect(pressContinue).toBeDefined();
  pressContinue!();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  return navigate.mock.calls[0]?.[0] as unknown;
}

beforeEach(() => {
  navigate.mockReset();
  post.mockReset().mockResolvedValue(me(SENDER));
  pressContinue = undefined;
  vi.stubGlobal('window', {
    location: { hash: `#token=${TOKEN}`, pathname: '/sign-in/continue' },
    history: { replaceState: () => undefined },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the sign-in link page', () => {
  it('says when continuing replaces the operator signed in here, and then goes home', async () => {
    const html = render(me('reader@example.com'));
    expect(html).toContain(`Sign in as <b class="text-ink">${SENDER}</b>`);
    expect(html).toContain('You are signed in as <b class="text-ink">reader@example.com</b>');
    expect(html).toContain('Continuing signs you in as');

    expect(await continueSignIn()).toEqual({ to: '/' });
    expect(post).toHaveBeenCalledWith('/api/v1/auth/quickpass/consume', {
      token: TOKEN,
      confirmEmail: SENDER,
    });
  });

  it('says so too for a session that still owes its second factor', async () => {
    // GET /api/v1/auth/session answers such a session with its operator (secondFactor: verify).
    const pending = me('reader@example.com', {
      state: 'verify',
      methods: ['totp'],
      required: false,
      enrollBy: null,
      verifiedWith: null,
    });
    expect(render(pending)).toContain(
      'You are signed in as <b class="text-ink">reader@example.com</b>',
    );
    expect(await continueSignIn()).toEqual({ to: '/' });
  });

  it('keeps the return path when the link is for the operator already signed in', async () => {
    const html = render(me(SENDER));
    expect(html).not.toContain('Continuing signs you in as');
    expect(await continueSignIn()).toEqual({ to: '/chosen-by-sender' });
  });

  it('still names the address when this browser has no session', () => {
    const html = render(new ApiError('unauthorized', 'Sign in to continue.', 401));
    expect(html).toContain(`Sign in as <b class="text-ink">${SENDER}</b>`);
    expect(html).toContain('Continue');
    expect(html).not.toContain('Continuing signs you in as');
  });
});
