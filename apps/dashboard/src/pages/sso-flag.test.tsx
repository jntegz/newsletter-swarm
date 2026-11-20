// The sso flag on the two pages that offer single sign-on, rendered with the flags already known.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { keys } from '../api/queries';
import { securityKeys } from '../api/security';
import { SignInPage } from './Auth';
import { SecuritySettings } from './Security';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => undefined,
}));

vi.mock('../session', () => ({
  ROLE_LABEL: {
    owner: 'Owner',
    admin: 'Admin',
    editor: 'Editor',
    author: 'Author',
    viewer: 'Viewer',
  },
  useSession: () => ({
    workspace: { id: 'ws_1', role: 'owner', plan: 'enterprise' },
    can: () => true,
  }),
}));

function render(page: ReactNode, flags?: Record<string, boolean>) {
  const client = new QueryClient();
  if (flags) client.setQueryData(keys.instanceFlags, { flags });
  client.setQueryData(securityKeys.overview, {
    secondFactor: { required: false, methods: [], state: 'ok' },
    passkeys: [],
    totp: { enabled: false },
    recoveryCodes: { remaining: 0 },
  });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

describe('the sign-in page', () => {
  it('offers SSO only when the flag is on', () => {
    expect(render(<SignInPage />, { sso: true })).toContain('Continue with SSO');
    expect(render(<SignInPage />, { sso: false })).not.toContain('Continue with SSO');
  });

  it('does not offer SSO while the flags are unknown', () => {
    expect(render(<SignInPage />)).not.toContain('Continue with SSO');
  });

  it('keeps sign-in by email and explains an SSO error either way', () => {
    const page = render(<SignInPage error="sso_cancelled" />, { sso: false });
    expect(page).toContain('Email address');
    expect(page).toContain('Single sign-on was cancelled.');
  });

  it('explains an error named like an Object.prototype member as an unknown one', () => {
    // The error comes from the address bar.
    for (const error of ['constructor', '__proto__', 'toString']) {
      expect(render(<SignInPage error={error} />), error).toContain(
        'Sign-in did not complete. Try again.',
      );
    }
  });
});

describe('Settings → Security', () => {
  it('shows SSO management only when the flag is on', () => {
    expect(render(<SecuritySettings />, { sso: true })).toContain('Single sign-on');
    expect(render(<SecuritySettings />, { sso: false })).not.toContain('Single sign-on');
    expect(render(<SecuritySettings />)).not.toContain('Single sign-on');
  });

  it('offers admins one action that pauses every outbound feed', () => {
    expect(render(<SecuritySettings />)).toContain('Pause all outbound feeds');
  });

  it('lists the account activity the operator alone sees', () => {
    const client = new QueryClient();
    client.setQueryData(securityKeys.overview, {
      secondFactor: { required: false, methods: [], state: 'ok' },
      passkeys: [],
      totp: { enabled: false },
      recoveryCodes: { remaining: 0 },
      activity: [
        {
          action: 'operator.signed_in',
          method: 'quickpass',
          ipPrefix: '192.0.2.0/24',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0',
          at: '2026-11-01T09:30:00.000Z',
        },
      ],
    });
    const page = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SecuritySettings />
      </QueryClientProvider>,
    );
    expect(page).toContain('Account activity');
    expect(page).toContain('Signed in');
    expect(page).toContain('email link');
    expect(page).toContain('network 192.0.2.0/24');
    expect(page).toContain('Firefox on macOS');
  });
});
