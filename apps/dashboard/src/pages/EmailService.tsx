import type { CheckedDnsRecord, InstanceMail } from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows, Pill, SelectField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { instanceMailQuery } from '../api/instance';
import { formatDateTime, numberFormat } from './common';
import {
  PREVIEW_SERVICES,
  SERVICE_NAMES,
  changeSteps,
  changeSummary,
  countMissing,
  mailNotices,
  serviceGuides,
  type ServiceGuide,
} from './email-service';
import { CopyButton, RecordStatePill } from './Sending';

const PURPOSE: Record<CheckedDnsRecord['purpose'], string> = {
  dkim: 'DKIM',
  mail_from_mx: 'Bounces',
  mail_from_spf: 'SPF',
  dmarc: 'DMARC',
  link: 'Link host',
};

const HEADING = 'table-head py-1.5 pr-3 text-left';

function RecordRow({ record }: { record: CheckedDnsRecord }) {
  const wrong = record.state !== 'ok' && record.found.length > 0;
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2 pr-3 whitespace-nowrap">{PURPOSE[record.purpose]}</td>
      <td className="py-2 pr-3 font-mono">{record.type}</td>
      <td className="py-2 pr-3">
        <span className="flex items-start gap-1 font-mono break-all">
          {record.name}
          <CopyButton value={record.name} label={`${PURPOSE[record.purpose]} name`} />
        </span>
      </td>
      <td className="py-2 pr-3">
        {record.value ? (
          <span className="flex items-start gap-1 font-mono break-all">
            {record.priority !== undefined ? `${record.priority} ` : ''}
            {record.value}
            <CopyButton value={record.value} label={`${PURPOSE[record.purpose]} value`} />
          </span>
        ) : (
          <span className="text-sub">From your mail server</span>
        )}
        {wrong && (
          <p className="mt-1 font-mono text-[11.5px] break-all text-sub">
            Found: {record.found.join(' | ')}
          </p>
        )}
      </td>
      <td className="py-2 whitespace-nowrap">
        <RecordStatePill state={record.state} />
      </td>
    </tr>
  );
}

function Records({ mail }: { mail: InstanceMail }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-[12.5px]">
        <thead>
          <tr className="text-sub">
            <th scope="col" className={HEADING}>
              For
            </th>
            <th scope="col" className={HEADING}>
              Type
            </th>
            <th scope="col" className={HEADING}>
              Name
            </th>
            <th scope="col" className={HEADING}>
              Value
            </th>
            <th scope="col" className={HEADING}>
              In DNS now
            </th>
          </tr>
        </thead>
        <tbody>
          {mail.records.map((record) => (
            <RecordRow key={`${record.type}-${record.name}-${record.value}`} record={record} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Limits({ ses }: { ses: NonNullable<InstanceMail['ses']> }) {
  if (ses.max24HourSend === null) return null;
  return (
    <p className="text-[13px] text-sub">
      AWS allows {numberFormat.format(ses.max24HourSend)} emails a day
      {ses.maxSendRate === null ? '' : `, ${numberFormat.format(ses.maxSendRate)} a second`}.
      {ses.sentLast24Hours === null
        ? ''
        : ` ${numberFormat.format(ses.sentLast24Hours)} sent in the last 24 hours.`}
    </p>
  );
}

function GuideRecords({ guide }: { guide: ServiceGuide }) {
  return (
    <ul className="grid gap-3">
      {guide.records.map((record) => (
        <li
          key={`${record.type}-${record.name}-${record.value}`}
          className="border-t border-line pt-2 text-[12.5px]"
        >
          <p className="text-sub">
            {record.purpose}: <span className="font-mono">{record.type}</span>
          </p>
          <p className="font-mono break-all">{record.name}</p>
          <p className="font-mono break-all text-sub">{record.value}</p>
        </li>
      ))}
    </ul>
  );
}

function ChangeUnderWay({ change }: { change: NonNullable<InstanceMail['change']> }) {
  return (
    <p className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px]">{changeSummary(change)}</p>
  );
}

function ChangeService({ mail }: { mail: InstanceMail }) {
  const guides = serviceGuides(mail.domain, mail.service);
  const [chosen, setChosen] = useState(guides[0]?.service);
  const guide = guides.find((candidate) => candidate.service === chosen) ?? guides[0];
  if (!guide) return null;
  return (
    <details className="border-t border-line pt-4">
      <summary className="cursor-pointer text-[14px] font-semibold">
        Change your email service
      </summary>
      <div className="mt-4 grid gap-4">
        <p className="text-[13px] text-sub">
          Swarm sends through one service at a time. Your current service keeps sending while you
          publish the new records, so nothing stops until you choose to move. A new service has no
          sending history, so warm-up starts again after the move, and large lists take a couple of
          weeks to reach everyone.
        </p>
        <SelectField
          label="Change to"
          value={guide.service}
          onChange={(event) => setChosen(event.target.value as ServiceGuide['service'])}
          options={guides.map((candidate) => ({
            value: candidate.service,
            label: SERVICE_NAMES[candidate.service],
          }))}
        />
        <div>
          <h3 className="text-[13px] font-semibold">What you’ll need</h3>
          <p className="mt-1 text-[13px] text-sub">{guide.needs}</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold">Records you’ll add</h3>
          <p className="mt-1 mb-3 text-[13px] text-sub">
            Exact values come from {SERVICE_NAMES[guide.service]} once it has your domain. Each
            publication then sees its own under Sending & delivery, and can check them there.
          </p>
          <GuideRecords guide={guide} />
        </div>
        <div>
          <h3 className="text-[13px] font-semibold">How to change</h3>
          <p className="mt-1 mb-2 text-[13px] text-sub">
            This changes your Workers, so it runs from where you installed Swarm, not from this
            page. You’ll need your recovery kit.
          </p>
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] text-sub">
            {changeSteps(guide.service).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    </details>
  );
}

/** Settings → Instance: the service this Swarm sends through. The page shows it to owners only. */
export function EmailService() {
  const mail = useQuery(instanceMailQuery);
  return (
    <section
      aria-labelledby="email-service-title"
      className="grid max-w-[760px] min-w-0 grid-cols-[minmax(0,1fr)] gap-6"
    >
      <div>
        <h2 id="email-service-title" className="text-[16px] font-semibold">
          Email service
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Where this Swarm’s email goes out from, and the DNS records that let it. Each
          publication’s own sending domains are under Sending & delivery.
        </p>
      </div>
      {mail.isPending && <LoadingRows label="Checking your email service" rows={3} />}
      {mail.error && <ErrorNotice message={mail.error.message} />}
      {mail.data && <Status mail={mail.data} checking={mail.isFetching} onCheck={mail.refetch} />}
    </section>
  );
}

function Status({
  mail,
  checking,
  onCheck,
}: {
  mail: InstanceMail;
  checking: boolean;
  onCheck: () => unknown;
}) {
  const toFix = countMissing(mail);
  return (
    <div className="card-app grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold">{SERVICE_NAMES[mail.service]}</span>
          {PREVIEW_SERVICES.includes(mail.service) && <Pill tone="neutral">Preview</Pill>}
          {mail.region && <span className="font-mono text-[12.5px] text-sub">{mail.region}</span>}
          <Pill tone={toFix ? 'danger' : 'success'}>
            {toFix ? `${toFix} ${toFix === 1 ? 'record' : 'records'} to fix` : 'Records look right'}
          </Pill>
        </div>
        <Button variant="ghost" size="sm" loading={checking} onClick={() => void onCheck()}>
          Check now
        </Button>
      </div>
      {mailNotices(mail).map((notice) => (
        <p
          key={notice.text}
          className={
            notice.tone === 'warn'
              ? 'rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px]'
              : 'text-[13px] text-sub'
          }
        >
          {notice.text}
        </p>
      ))}
      <div>
        <p className="mb-2 text-[13px] text-sub">
          Sending from <span className="font-mono">{mail.domain}</span>. Last checked{' '}
          {formatDateTime(mail.checkedAt)}.
        </p>
        <Records mail={mail} />
      </div>
      {mail.ses && <Limits ses={mail.ses} />}
      {mail.change ? <ChangeUnderWay change={mail.change} /> : <ChangeService mail={mail} />}
    </div>
  );
}
