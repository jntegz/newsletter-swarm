// A fresh second-factor check before a sensitive change (step-up): factor changes in Settings →
// Security, and anything that sets up standing access to a workspace's data (API keys, webhook
// endpoints, export destinations). The API answers 403 `secondFactor: step_up_required`; the
// dialog verifies and retries the change. `factor_required` (no factor at all) is left to the
// form's own error, which says to add one first.
import type { SecondFactorStatus } from '@swarm/domain';
import { Button, Dialog } from '@swarm/ui/components';
import { useRef, useState } from 'react';
import { needsStepUp, useAfterVerify } from '../api/security';
import { useSession } from '../session';
import { VerifyForm } from './SecurityParts';

/**
 * Runs a sensitive change; when the server asks for a fresh check, shows the verify dialog and
 * retries the change once the operator has verified. Without `methods`, the signed-in operator's.
 */
export function useStepUp(methods?: SecondFactorStatus['methods']) {
  const { me } = useSession();
  const usable = methods ?? (me.secondFactor?.methods.length ? me.secondFactor.methods : ['totp']);
  const afterVerify = useAfterVerify();
  const pending = useRef<(() => Promise<unknown>) | null>(null);
  const [open, setOpen] = useState(false);

  const guard = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      if (!needsStepUp(error)) throw error;
      pending.current = action;
      setOpen(true);
    }
  };

  const dialog = (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Confirm it is you"
      description="This change needs a fresh check with your second factor."
      actions={
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      }
    >
      {open && (
        <VerifyForm
          methods={usable}
          submitLabel="Confirm"
          onVerified={async (me) => {
            await afterVerify(me);
            setOpen(false);
            const action = pending.current;
            pending.current = null;
            await action?.();
          }}
        />
      )}
    </Dialog>
  );
  return { guard, dialog };
}

/** An error worth showing in a form: not the step-up request, which the dialog handles. */
export function formError<T>(error: T | null | undefined): T | null {
  return error == null || needsStepUp(error) ? null : error;
}
