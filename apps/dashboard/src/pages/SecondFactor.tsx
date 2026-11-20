// The step after QuickPass, Google or SSO when the session still owes a second factor: verify
// with a passkey, an authenticator app or a recovery code, or (after the grace period) set one
// up first. The API refuses everything else for such a session (401 mfa_required).
import type { FactorAdded } from '@swarm/domain';
import { Button, ErrorNotice, TextField } from '@swarm/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { meQuery } from '../api/queries';
import { addPasskey, passkeysSupported, useAfterVerify } from '../api/security';
import { AuthCard } from './Auth';
import { RecoveryCodesView, TotpSetup, VerifyForm, problemMessage } from './SecurityParts';

export function SecondFactorPage({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useQuery({ ...meQuery, staleTime: 0, throwOnError: false });
  const afterVerify = useAfterVerify();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [setup, setSetup] = useState<'choose' | 'passkey' | 'totp'>('choose');
  const [passkeyName, setPasskeyName] = useState('Passkey');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = returnTo ?? '/';

  const signOut = async () => {
    await api.post('/api/v1/auth/logout').catch(() => undefined);
    client.removeQueries({ queryKey: meQuery.queryKey });
    await navigate({ to: '/sign-in', search: {} });
  };

  const added = async (result: FactorAdded) => {
    await afterVerify();
    if (result.recoveryCodes) setCodes(result.recoveryCodes);
    else await navigate({ to: target });
  };

  if (me.isPending) return <AuthCard title="Checking your sign-in">{null}</AuthCard>;

  if (!me.data) {
    return (
      <AuthCard title="Sign in first">
        <p className="mt-2 text-[14px] text-sub">Your sign-in expired. Start again.</p>
        <Link to="/sign-in" search={{ return: target }} className="btn-primary mt-6 w-full">
          Sign in
        </Link>
      </AuthCard>
    );
  }

  if (codes) {
    return (
      <AuthCard title="Save your recovery codes">
        <div className="mt-4">
          <RecoveryCodesView codes={codes} onDone={() => void navigate({ to: target })} />
        </div>
      </AuthCard>
    );
  }

  const status = me.data.secondFactor;
  if (!status || status.state === 'ok') return <Navigate to={target} />;

  const footer = (
    <p className="mt-6 text-[13px] text-sub">
      Signed in as <b className="text-ink">{me.data.operator.email}</b>.{' '}
      <button
        type="button"
        onClick={() => void signOut()}
        className="font-semibold text-purple-deep underline-offset-2 hover:underline"
      >
        Sign out
      </button>
    </p>
  );

  if (status.state === 'verify') {
    return (
      <AuthCard title="Confirm it is you">
        <p className="mt-1.5 mb-5 text-[14px] text-sub">
          Your account has a second factor. Use it to finish signing in.
        </p>
        <VerifyForm
          methods={status.methods}
          onVerified={async (verified) => {
            await afterVerify(verified);
            await navigate({ to: target });
          }}
        />
        {footer}
      </AuthCard>
    );
  }

  const createPasskey = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await added(await addPasskey(passkeyName.trim() || 'Passkey'));
    } catch (error) {
      setProblem(problemMessage(error, 'The passkey was not added. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set up a second factor">
      <p className="mt-1.5 mb-5 text-[14px] text-sub">
        Your role needs a second factor, and the time to add one has run out. Add one now to
        continue.
      </p>
      {setup === 'choose' && (
        <div className="grid gap-2">
          {passkeysSupported() && (
            <Button onClick={() => setSetup('passkey')}>Add a passkey</Button>
          )}
          <Button variant="ghost" onClick={() => setSetup('totp')}>
            Use an authenticator app
          </Button>
        </div>
      )}
      {setup === 'passkey' && (
        <div className="grid gap-4">
          <TextField
            label="Name for this passkey"
            maxLength={80}
            value={passkeyName}
            onChange={(event) => setPasskeyName(event.target.value)}
            hint="So you can tell your passkeys apart, for example Work laptop."
          />
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => void createPasskey()}>
              Create passkey
            </Button>
            <Button variant="ghost" onClick={() => setSetup('choose')}>
              Back
            </Button>
          </div>
          <div role="status" aria-live="polite">
            {problem && <ErrorNotice title="Passkey not added" message={problem} />}
          </div>
        </div>
      )}
      {setup === 'totp' && <TotpSetup onDone={added} onCancel={() => setSetup('choose')} />}
      {footer}
    </AuthCard>
  );
}
