// Pieces shared by the sign-in second-factor step and Settings → Security: verifying with a
// passkey, an authenticator app code or a recovery code; setting up an authenticator app (the QR
// code is drawn here, in the browser, from the otpauth URI); showing recovery codes once.
import type { FactorAdded, Me, SecondFactorStatus, TotpEnrollment } from '@swarm/domain';
import { Button, ErrorNotice, TextField } from '@swarm/ui/components';
import { useState, type FormEvent } from 'react';
import { encode } from 'uqr';
import { ApiError } from '../api/client';
import {
  confirmTotp,
  passkeysSupported,
  startTotp,
  verifyWithPasskey,
  verifyWithRecoveryCode,
  verifyWithTotp,
} from '../api/security';

type Method = SecondFactorStatus['methods'][number];

const METHOD_LABEL: Record<Method, string> = {
  passkey: 'Passkey',
  totp: 'Authenticator app',
  recovery: 'Recovery code',
};

/** A browser that cancels or times out the passkey prompt throws a DOMException. */
export function problemMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'The passkey prompt was closed or timed out. Try again.';
  }
  return fallback;
}

/** Verify with one of the operator's methods. Calls onVerified with the refreshed session. */
export function VerifyForm({
  methods,
  onVerified,
  submitLabel = 'Continue',
}: {
  methods: Method[];
  onVerified: (me: Me) => void | Promise<void>;
  submitLabel?: string;
}) {
  const usable = methods.filter((m) => m !== 'passkey' || passkeysSupported());
  const [method, setMethod] = useState<Method | undefined>(usable[0]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (action: () => Promise<Me>) => {
    setBusy(true);
    setProblem(null);
    try {
      await onVerified(await action());
    } catch (error) {
      setProblem(problemMessage(error, 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (method === 'totp') void run(() => verifyWithTotp(code));
    if (method === 'recovery') void run(() => verifyWithRecoveryCode(code));
  };

  if (!method) {
    return (
      <ErrorNotice
        title="No way to verify here"
        message="This browser cannot use your passkey and no other method is set up. Try another browser or device."
      />
    );
  }

  return (
    <div className="grid gap-4">
      {usable.length > 1 && (
        <fieldset>
          <legend className="text-[13px] font-semibold">Verify with</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {usable.map((m) => (
              <label
                key={m}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-line-control px-3 text-[13.5px] has-checked:border-purple has-checked:bg-lavender has-focus-visible:outline-2 has-focus-visible:outline-purple"
              >
                <input
                  type="radio"
                  name="second-factor-method"
                  value={m}
                  checked={method === m}
                  onChange={() => {
                    setMethod(m);
                    setCode('');
                    setProblem(null);
                  }}
                  className="accent-purple"
                />
                {METHOD_LABEL[m]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {method === 'passkey' ? (
        <Button loading={busy} onClick={() => void run(verifyWithPasskey)}>
          Use your passkey
        </Button>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <TextField
            label={method === 'totp' ? '6-digit code' : 'Recovery code'}
            name="code"
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            required
            maxLength={method === 'totp' ? 7 : 16}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            hint={
              method === 'totp'
                ? 'From the authenticator app on your phone.'
                : 'One of the codes you saved. Each works once.'
            }
          />
          <Button type="submit" loading={busy} disabled={!code.trim()}>
            {submitLabel}
          </Button>
        </form>
      )}
      <div role="status" aria-live="polite">
        {problem && <ErrorNotice title="Not verified" message={problem} />}
      </div>
    </div>
  );
}

/** A QR code drawn as SVG rects from the matrix; nothing leaves the browser. */
function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="size-44 rounded-card-app border border-line bg-white p-1"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#0f0f12" /> : null,
        ),
      )}
    </svg>
  );
}

/** Set up an authenticator app: scan or type the secret, then confirm with a code. */
export function TotpSetup({
  onDone,
  onCancel,
  guard = async (action) => {
    await action();
  },
}: {
  onDone: (result: FactorAdded) => void | Promise<void>;
  onCancel?: () => void;
  /** Wraps each request, e.g. to ask for a fresh second-factor check and retry. */
  guard?: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await guard(async () => setEnrollment(await startTotp()));
    } catch (error) {
      setProblem(problemMessage(error, 'Setting up the app did not start. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await guard(async () => onDone(await confirmTotp(code)));
    } catch (error) {
      setProblem(problemMessage(error, 'That code did not match. Try the next one.'));
    } finally {
      setBusy(false);
    }
  };

  if (!enrollment) {
    return (
      <div className="grid gap-3">
        <p className="text-[13.5px] text-sub">
          Use any authenticator app that supports time-based codes. You scan a QR code, then type
          the 6-digit code it shows.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button loading={busy} onClick={() => void begin()}>
            Set up an authenticator app
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        {problem && <ErrorNotice message={problem} />}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void confirm(event)} className="grid gap-4">
      <div className="flex flex-wrap items-start gap-5">
        <QrCode value={enrollment.uri} label="QR code for your authenticator app" />
        <div className="grid max-w-[32ch] gap-2 text-[13.5px]">
          <p>Scan the code with your app. Cannot scan? Type this key instead:</p>
          <code className="rounded-[10px] bg-surface-alt px-3 py-2 font-mono text-[13px] break-all">
            {enrollment.secret.match(/.{1,4}/g)?.join(' ')}
          </code>
        </div>
      </div>
      <TextField
        label="6-digit code from the app"
        name="totp-code"
        autoComplete="one-time-code"
        inputMode="numeric"
        required
        maxLength={7}
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={!code.trim()}>
          Turn on
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <div role="status" aria-live="polite">
        {problem && <ErrorNotice title="Not turned on" message={problem} />}
      </div>
    </form>
  );
}

/** Recovery codes, shown once. The operator confirms they saved them before moving on. */
export function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `${codes.join('\n')}\n`;
  const href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

  return (
    <div className="grid gap-4">
      <p className="text-[13.5px] text-sub">
        Each code signs you in once if you lose your passkey or phone. They are shown only now:
        store them somewhere safe, such as a password manager.
      </p>
      <ol
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-card-app bg-surface-alt px-5 py-4 font-mono text-[14px] tabular-nums"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <a href={href} download="swarm-recovery-codes.txt" className="btn-ghost btn-sm">
          Download
        </a>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          Copy
        </Button>
        <span role="status" className="text-[13px] text-success">
          {copied ? 'Copied.' : ''}
        </span>
      </div>
      <Button onClick={onDone}>I saved my recovery codes</Button>
    </div>
  );
}
