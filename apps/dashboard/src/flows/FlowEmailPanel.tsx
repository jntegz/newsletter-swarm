// The Dispatch editor's side panel for a Flow email: it is sent by its Flow, never on its own.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { flowQuery } from '../api/flows';
import { FlowPill } from './status';

export function FlowEmailPanel({ flowId }: { flowId: string }) {
  const flow = useQuery(flowQuery(flowId));
  return (
    <aside aria-label="Automation email" className="grid content-start gap-4">
      <section className="card-app p-5">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em]">Automation email</h2>
        <p className="mt-1 text-[13px] leading-[1.5] text-sub">
          This email is sent by its automation when a run reaches its step, with the same checks as
          a regular send. Changes reach subscribers once the automation is published again.
        </p>
        {flow.data && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-semibold">{flow.data.name}</span>
            <FlowPill status={flow.data.status} />
          </p>
        )}
        <Link to="/flows/$flowId" params={{ flowId }} className="btn-ghost btn-sm mt-4 inline-flex">
          Back to the automation
        </Link>
      </section>
    </aside>
  );
}
