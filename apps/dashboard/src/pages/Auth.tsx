import type { FirstFactorUndone, Me, QuickPassPeek, Workspace } from '@swarm/domain';
import { Button, ErrorNotice, TextField } from '@swarm/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import { instanceQuery } from '../api/instance';
import { authConfigQuery, keys, meQuery, usePlatformFlag } from '../api/queries';
import * as Icon from '../icons';
import { Turnstile } from '../Turnstile';

const INVITE_ONLY = 'This Swarm is invite-only. Ask the owner for an invite.';

const GOOGLE_ERRORS: Record<string, string> = {
  invite_only: INVITE_ONLY,
  google_unverified: 'Google has not verified that email address. Use a sign-in link instead.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'That Google sign-in expired. Try again.',
  google_exchange: 'Google sign-in did not complete. Try again.',
  google_token: 'Google sign-in could not be verified. Try again.',
  sso_start: 'Start single sign-on from this page.',
  sso_unknown: 'No single sign-on is set up for that email domain. Use a sign-in link instead.',
  sso_unavailable: 'Single sign-on for that domain is not available right now.',
  sso_cancelled: 'Single sign-on was cancelled.',
  sso_state: 'That single sign-on expired. Try again.',
  sso_exchange: 'Your identity provider did not complete the sign-in. Try again.',
  sso_token: 'Your identity provider’s answer could not be verified. Try again.',
  sso_unverified: 'Your identity provider has not verified that email address.',
  sso_domain: 'That address is not on a domain this single sign-on covers.',
  sso_no_seat: 'Your workspace has not given you a seat yet. Ask an admin to invite you.',
  email_signin_required:
    'Your second factor was removed with the link in your email, so sign in with an email link this time.',
};

/** Where to go after a first factor: the second-factor step when the session still owes one. */
const afterFirstFactor = (me: Me, returnTo?: string) =>
  me.secondFactor && me.secondFactor.state !== 'ok'
    ? ({ to: '/sign-in/verify', search: returnTo ? { return: returnTo } : {} } as const)
    : ({ to: returnTo ?? '/' } as const);

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <p className="mb-6 flex items-center justify-center gap-2.5 text-[17px] font-bold">
          <span className="grid size-8 place-items-center rounded-control bg-rail">
            <Icon.LineMark size={22} />
          </span>
          Swarm
        </p>
        <section className="card-app p-7 shadow-card">
          <h1 className="text-[22px] leading-[1.2] font-semibold tracking-[-0.01em]">{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

export function SignInPage({
  returnTo,
  error,
  email: initialEmail,
}: {
  returnTo?: string;
  error?: string;
  email?: string;
}) {
  const navigate = useNavigate();
  const config = useQuery(authConfigQuery);
  const instance = useQuery(instanceQuery);
  const ssoOn = usePlatformFlag('sso');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [sending, setSending] = useState(false);
  const [ssoHint, setSsoHint] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setSending(true);
    setProblem(null);
    try {
      await api.post('/api/v1/auth/quickpass', {
        email,
        turnstileToken: token,
        ...(returnTo ? { returnTo } : {}),
      });
      await navigate({ to: '/sign-in/check-email', search: { email } });
    } catch (e) {
      setProblem(e instanceof ApiError ? e : null);
      setToken(null);
    } finally {
      setSending(false);
    }
  };

  const googleHref = `/api/v1/auth/google${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`;

  return (
    <AuthCard title="Sign in to Swarm">
      <p className="mt-1.5 text-[14px] text-sub">We will email you a link. No password needed.</p>
      {instance.data?.signup === 'invite_only' && error !== 'invite_only' && (
        <p className="mt-1 text-[13px] text-sub">{INVITE_ONLY}</p>
      )}
      {error && (
        <div className="mt-5">
          <ErrorNotice
            title={error === 'invite_only' ? 'No invite for that address' : 'Not signed in'}
            message={
              // Own keys only: ?error=__proto__ from the address bar is an unknown error.
              (Object.hasOwn(GOOGLE_ERRORS, error) ? GOOGLE_ERRORS[error] : undefined) ??
              'Sign-in did not complete. Try again.'
            }
          />
        </div>
      )}
      <form onSubmit={submit} className="mt-6 grid gap-4" noValidate={false}>
        <TextField
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={problem?.field('email')}
        />
        {config.data && (
          <Turnstile
            siteKey={config.data.turnstileSiteKey}
            action="quickpass"
            onToken={setToken}
            onError={() => setCheckFailed(true)}
          />
        )}
        {checkFailed && (
          <ErrorNotice
            title="Security check unavailable"
            message="The bot check could not load. Disable blockers for this page, then reload."
          />
        )}
        {problem && !problem.field('email') && <ErrorNotice message={problem.message} />}
        <Button type="submit" loading={sending} disabled={!token && !checkFailed}>
          {token || checkFailed ? 'Email me a sign-in link' : 'Checking your browser…'}
        </Button>
      </form>
      {config.data?.googleEnabled && (
        <>
          <p className="my-5 flex items-center gap-3 text-[12px] text-sub before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
            or
          </p>
          <a href={googleHref} className="btn-ghost w-full">
            Continue with Google
          </a>
        </>
      )}
      {ssoOn && (
        <>
          <p className="mt-5 text-center text-[13px] text-sub">
            Your company uses single sign-on?{' '}
            <button
              type="button"
              className="font-semibold text-purple-deep underline-offset-2 hover:underline"
              onClick={() => {
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                  setSsoHint(true);
                  document.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
                  return;
                }
                // A form post, not a link: the API starts SSO only for a request that proves it
                // came from this page, and a post carries Origin in every browser, while a GET
                // navigation needs Sec-Fetch-Site, which older Safari and Firefox never send.
                const form = document.createElement('form');
                form.method = 'post';
                form.action = '/api/v1/auth/sso/start';
                form.hidden = true;
                const fields: Record<string, string> = { email: email.trim() };
                if (returnTo) fields.return = returnTo;
                for (const [name, value] of Object.entries(fields)) {
                  const input = document.createElement('input');
                  input.type = 'hidden';
                  input.name = name;
                  input.value = value;
                  form.append(input);
                }
                document.body.append(form);
                form.submit();
              }}
            >
              Continue with SSO
            </button>
          </p>
          <p role="status" className="mt-1 text-center text-[13px] text-sub">
            {ssoHint ? 'Enter your work email above first.' : ''}
          </p>
        </>
      )}
    </AuthCard>
  );
}

export function CheckEmailPage({ email }: { email?: string }) {
  const config = useQuery(authConfigQuery);
  return (
    <AuthCard title="Check your inbox">
      <p className="mt-2 text-[14px] leading-[1.55] text-sub">
        We sent a sign-in link to <b className="text-ink">{email ?? 'your email address'}</b>. It
        works once and expires in 10 minutes.
      </p>
      {config.data?.devMailbox && (
        <p className="mt-4 rounded-card-app border border-dashed border-lavender-line bg-surface-alt px-4 py-3 text-[13px]">
          Local development: mail is not delivered.{' '}
          <a
            href="/__dev/mail"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-purple-deep"
          >
            Open the dev mailbox
          </a>
        </p>
      )}
      <p className="mt-6 text-[13px] text-sub">
        Wrong address or no email?{' '}
        <Link
          to="/sign-in"
          search={email ? { email } : {}}
          className="font-semibold text-purple-deep"
        >
          Send a new link
        </Link>
      </p>
    </AuthCard>
  );
}

function readFragmentToken(): string | null {
  const match = /(?:^|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash.slice(1));
  return match?.[1] ?? null;
}

/**
 * The emailed link opens this page. Signing in needs a click, so mail scanners that
 * open links in advance cannot spend the one-time token. The page names the account first:
 * anyone can send a link to their own account, and continuing must not sign someone in to it
 * unseen.
 */
/**
 * "This wasn't me" from the mail about an account's first second factor. Opening the link changes
 * nothing; the button removes the factor, signs out every device and asks for an email sign-in.
 */
export function UndoFactorPage() {
  const client = useQueryClient();
  const [token] = useState(readFragmentToken);
  const [done, setDone] = useState<FirstFactorUndone | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const undo = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await api.post<FirstFactorUndone>('/api/v1/auth/undo-first-factor', { token });
      window.history.replaceState(null, '', window.location.pathname);
      client.clear();
      setDone(result);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="Your account is back to how it was">
        <p className="mt-2 text-[14px] text-sub">
          The second factor was removed and every device was signed out
          {done.sessionsEnded ? ` (${done.sessionsEnded})` : ''}. Sign in with an email link, then
          add a passkey or an authenticator app of your own in Settings → Security.
        </p>
        <Link to="/sign-in" search={{}} className="btn-primary mt-6 w-full">
          Sign in with an email link
        </Link>
      </AuthCard>
    );
  }
  const unusable =
    problem ?? (!token ? 'The link is incomplete. Open it from the email again.' : null);
  if (unusable) {
    return (
      <AuthCard title="This link cannot be used">
        <p className="mt-2 text-[14px] text-sub">{unusable}</p>
        <Link to="/sign-in" search={{}} className="btn-primary mt-6 w-full">
          Go to sign-in
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Wasn’t you?">
      <p className="mt-2 text-[14px] text-sub">
        If you did not add a second factor to your account, remove it now. Every device signed in to
        your account is signed out, and you sign in again with an email link. The link works once.
      </p>
      <p className="mt-4 text-[13px] text-sub">If you did add it yourself, close this page.</p>
      <Button variant="danger" className="mt-6 w-full" onClick={() => void undo()} loading={busy}>
        Remove it and sign out everywhere
      </Button>
    </AuthCard>
  );
}

export function ContinuePage({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [token] = useState(readFragmentToken);
  const current = useQuery({ ...meQuery, throwOnError: false });
  const target = useQuery({
    queryKey: ['quickpass', token],
    queryFn: () => api.post<QuickPassPeek>('/api/v1/auth/quickpass/peek', { token }),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    throwOnError: false,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = target.data?.email;
  const signedInAs = current.data?.operator.email;
  const switching = !!signedInAs && !!email && signedInAs !== email;

  const consume = async () => {
    if (!token || !email) return;
    setBusy(true);
    try {
      const me = await api.post<Me>('/api/v1/auth/quickpass/consume', {
        token,
        confirmEmail: email,
      });
      client.setQueryData(keys.me, me);
      window.history.replaceState(null, '', window.location.pathname);
      // A link that changes who is signed in goes home: whoever sent it does not pick the page.
      await navigate(afterFirstFactor(me, switching ? undefined : returnTo));
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Sign-in did not complete. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const unusable =
    problem ??
    (!token
      ? 'The link is incomplete. Open it from the email again, or ask for a new one.'
      : target.isError
        ? target.error instanceof ApiError
          ? target.error.message
          : 'This sign-in link could not be checked. Try again.'
        : null);
  if (unusable) {
    return (
      <AuthCard title="This link cannot be used">
        <p className="mt-2 text-[14px] text-sub">{unusable}</p>
        <Link to="/sign-in" search={{}} className="btn-primary mt-6 w-full">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  if (!email || current.isPending) {
    return <AuthCard title="Checking your link">{null}</AuthCard>;
  }

  return (
    <AuthCard title="Continue to Swarm">
      <p className="mt-2 text-[14px] text-sub">
        Sign in as <b className="text-ink">{email}</b> on this device.
      </p>
      {switching && (
        <p className="mt-4 rounded-[12px] border border-dashed border-lavender-line bg-surface-alt px-4 py-3 text-[13px]">
          You are signed in as <b className="text-ink">{signedInAs}</b>. Continuing signs you in as{' '}
          <b className="text-ink">{email}</b> instead.
        </p>
      )}
      <p className="mt-4 text-[13px] text-sub">
        If you did not ask for this link, close this page.
      </p>
      <Button className="mt-6 w-full" onClick={() => void consume()} loading={busy}>
        Continue
      </Button>
    </AuthCard>
  );
}

const INVITE_KEY = 'swarm:invite';

function rememberInvite(): string | null {
  const fromHash = readFragmentToken();
  try {
    if (fromHash) {
      window.sessionStorage.setItem(INVITE_KEY, fromHash);
      window.history.replaceState(null, '', window.location.pathname);
    }
    return fromHash ?? window.sessionStorage.getItem(INVITE_KEY);
  } catch {
    return fromHash;
  }
}

export function InvitePage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useQuery({ ...meQuery, throwOnError: false });
  const [token] = useState(rememberInvite);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me.isPending) {
    return <AuthCard title="Checking your invite">{null}</AuthCard>;
  }

  if (!token) {
    // Invite-only sign-up lets an invited person in before they join a workspace; the app sends
    // them here until they accept.
    const waiting = me.data && me.data.workspaces.length === 0;
    return (
      <AuthCard title={waiting ? 'Accept your invite' : 'Invite link incomplete'}>
        <p className="mt-2 text-[14px] text-sub">
          {waiting ? (
            <>
              You are signed in as <b className="text-ink">{me.data?.operator.email}</b> but have
              not joined a workspace yet. Open the invite from your email to join.
            </>
          ) : (
            'Open the invite from the email again.'
          )}
        </p>
      </AuthCard>
    );
  }

  if (!me.data) {
    return (
      <AuthCard title="You have been invited">
        <p className="mt-2 text-[14px] text-sub">
          Sign in with the address the invite was sent to, then accept it.
        </p>
        <Link to="/sign-in" search={{ return: '/invite' }} className="btn-primary mt-6 w-full">
          Sign in to accept
        </Link>
      </AuthCard>
    );
  }

  const accept = async () => {
    setBusy(true);
    try {
      const workspace = await api.post<Workspace>('/api/v1/invites/accept', { token });
      try {
        window.sessionStorage.removeItem(INVITE_KEY);
        window.localStorage.setItem('swarm:workspace', workspace.id);
      } catch {
        // Storage can be blocked; nothing to clean up then.
      }
      await client.invalidateQueries({ queryKey: keys.me });
      await navigate({ to: '/' });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The invite could not be accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Join the workspace">
      <p className="mt-2 text-[14px] text-sub">
        You are signed in as <b className="text-ink">{me.data.operator.email}</b>.
      </p>
      {problem && (
        <div className="mt-4">
          <ErrorNotice title="Invite not accepted" message={problem} />
        </div>
      )}
      <Button className="mt-6 w-full" onClick={() => void accept()} loading={busy}>
        Accept invite
      </Button>
    </AuthCard>
  );
}
