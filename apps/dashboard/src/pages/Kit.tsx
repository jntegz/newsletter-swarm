// Storybook-lite: every @swarm/ui component in every state, on one page. Registered only in
// development builds (`/_kit`, see router.tsx); the values here are made up for display and
// never reach a real workspace.
import {
  BarChart,
  Button,
  Checkbox,
  Dialog,
  Donut,
  EmptyState,
  ErrorNotice,
  Kpi,
  LineChart,
  LoadingRows,
  Pill,
  Progress,
  SelectField,
  Skeleton,
  Spinner,
  Switch,
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
  ToastProvider,
  ToastRegion,
  useToast,
  type TableColumn,
  type Toast,
} from '@swarm/ui/components';
import { useState, type ReactNode } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `kit-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="card-app grid gap-4 p-5">
      <h2 id={id} className="text-[16px] font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function State({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <p className="text-[11.5px] font-semibold text-sub">{name}</p>
      {children}
    </div>
  );
}

const grid = 'grid gap-5 sm:grid-cols-2 lg:grid-cols-3';

function ButtonsDemo() {
  return (
    <Section title="Button">
      <div className="flex flex-wrap items-center gap-3">
        <Button>Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="quiet">Quiet</Button>
        <Button size="sm">Small</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
        <Spinner label="Loading" />
      </div>
    </Section>
  );
}

function FieldsDemo() {
  return (
    <Section title="Fields">
      <div className={grid}>
        <TextField label="Default" placeholder="name@example.com" />
        <TextField label="With hint" hint="Shown to subscribers." defaultValue="Field Notes" />
        <TextField label="Error" error="Enter an email address." defaultValue="nope" />
        <TextField label="Disabled" disabled defaultValue="Locked" />
        <SelectField
          label="Select"
          options={[
            { value: 'a', label: 'Weekly' },
            { value: 'b', label: 'Monthly' },
          ]}
        />
        <TextAreaField label="Text area" defaultValue="Two lines of text." />
      </div>
    </Section>
  );
}

function TogglesDemo() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  return (
    <Section title="Checkbox and Switch">
      <div className={grid}>
        <Checkbox label="Checked" checked={a} onChange={setA} />
        <Checkbox
          label="Unchecked, with hint"
          hint="Explains the choice."
          checked={false}
          onChange={() => {}}
        />
        <Checkbox label="Some selected" checked={false} indeterminate onChange={() => {}} />
        <Checkbox label="Disabled" checked disabled onChange={() => {}} />
        <Checkbox
          label="Error"
          error="Accept the terms to continue."
          checked={false}
          onChange={() => {}}
        />
        <Switch label="Switch" hint="Takes effect at once." checked={b} onChange={setB} />
        <Switch label="Switch, on" checked onChange={() => {}} />
        <Switch label="Switch, saving" checked loading onChange={() => {}} />
        <Switch label="Switch, disabled" checked={false} disabled onChange={() => {}} />
        <Switch
          label="Switch, error"
          error="Couldn’t save. Try again."
          checked={false}
          onChange={() => {}}
        />
      </div>
    </Section>
  );
}

function TabsDemo() {
  const [tab, setTab] = useState<'one' | 'two' | 'three'>('one');
  return (
    <Section title="Tabs">
      <div>
        <Tabs
          label="Example"
          tabs={[
            { id: 'one', label: 'Build' },
            { id: 'two', label: 'Embed' },
            { id: 'three', label: 'Stats (disabled)', disabled: true },
          ]}
          value={tab}
          onChange={setTab}
          idFor={(id) => `kit-tab-${id}`}
          panelFor={(id) => `kit-panel-${id}`}
        />
        <TabPanel
          id={`kit-panel-${tab}`}
          labelledBy={`kit-tab-${tab}`}
          className="pt-4 text-[13.5px]"
        >
          Panel for {tab}. Arrow keys, Home and End move between tabs.
        </TabPanel>
      </div>
    </Section>
  );
}

interface Row {
  title: string;
  status: 'sent' | 'scheduled' | 'draft';
  opens: number | null;
}

const ROWS: Row[] = [
  { title: 'Spring field guide', status: 'sent', opens: 54.2 },
  { title: 'Letters from the coast', status: 'scheduled', opens: null },
  { title: 'Untitled post', status: 'draft', opens: null },
];

const COLUMNS: TableColumn<Row>[] = [
  { key: 'title', header: 'Post', cell: (r) => r.title, rowHeader: true },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => <span className={`status-pill status-${r.status}`}>{r.status}</span>,
  },
  {
    key: 'opens',
    header: 'Opens',
    cell: (r) => (r.opens === null ? '—' : `${r.opens}%`),
    align: 'right',
  },
];

function TableDemo() {
  return (
    <Section title="Table">
      <div className="grid gap-5">
        <State name="Default">
          <Table caption="Example posts" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.title} />
        </State>
        <State name="Loading">
          <Table
            caption="Example posts"
            columns={COLUMNS}
            rows={undefined}
            rowKey={(r) => r.title}
            loading
          />
        </State>
        <State name="Empty">
          <Table
            caption="Example posts"
            columns={COLUMNS}
            rows={[]}
            rowKey={(r) => r.title}
            empty="No posts yet."
          />
        </State>
        <State name="Error">
          <Table
            caption="Example posts"
            columns={COLUMNS}
            rows={undefined}
            rowKey={(r) => r.title}
            error="The posts didn’t load. Try again."
          />
        </State>
      </div>
    </Section>
  );
}

function ToastButtons() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" onClick={() => toast.show('Saved.')}>
        Show success
      </Button>
      <Button variant="ghost" onClick={() => toast.show('Link copied.', 'neutral')}>
        Show neutral
      </Button>
      <Button variant="ghost" onClick={() => toast.show('Couldn’t save. Try again.', 'error')}>
        Show error
      </Button>
    </div>
  );
}

const STATIC_TOASTS: Toast[] = [
  { id: 1, tone: 'success', message: 'Saved.' },
  { id: 2, tone: 'neutral', message: 'Link copied.' },
];

function ToastDemo() {
  return (
    <Section title="Toast">
      <div className={grid}>
        <State name="Live (fixed, bottom right)">
          <ToastButtons />
        </State>
        <State name="Static">
          <ToastRegion inline toasts={STATIC_TOASTS} onDismiss={() => {}} />
        </State>
      </div>
    </Section>
  );
}

function DataDemo() {
  const labels = ['#41', '#42', '#43', '#44', '#45', '#46'];
  const series = [
    { label: 'Opens', values: [48, 51, 47, 53, 55, 52] },
    { label: 'Clicks', values: [4, 5, 3.8, 6, 5.5, 5.1] },
  ];
  const percent = (v: number) => `${v}%`;
  return (
    <>
      <Section title="KPI">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi
            label="Subscribers"
            value="12,480"
            delta={{ label: '4.2%', direction: 'up' }}
            hint="Last 30 days"
          />
          <Kpi
            label="Unsubscribes"
            value="38"
            delta={{ label: '12%', direction: 'down', good: true }}
            hint="Fewer is better"
          />
          <Kpi label="Open rate" value="" loading />
          <Kpi label="Revenue" value="" empty="After your first payment" />
        </div>
      </Section>
      <Section title="Charts">
        <div className="grid gap-6 lg:grid-cols-2">
          <LineChart
            title="Line"
            subtitle="Unique rates"
            labels={labels}
            series={series}
            format={percent}
          />
          <BarChart
            title="Bar"
            subtitle="One series"
            labels={labels}
            series={series.slice(0, 1)}
            format={percent}
          />
          <LineChart title="Loading" labels={[]} series={[]} loading />
          <BarChart title="Empty" labels={[]} series={[]} empty="Nothing sent yet." />
          <LineChart
            title="Error"
            labels={[]}
            series={[]}
            error="The numbers didn’t load. Try again."
          />
        </div>
      </Section>
      <Section title="Donut and Progress">
        <div className={grid}>
          <Donut label="Opened" value={312} total={560} />
          <Donut label="Nothing yet" value={0} total={0} center="—" />
          <Donut label="Loading" value={0} total={0} loading />
          <div className="grid content-start gap-5">
            <Progress
              label="Welcome automation"
              value={80}
              max={120}
              meta="120 triggered · 80 completed"
            />
            <Progress label="Empty" value={0} max={0} valueText="Not started" />
            <Progress label="Done" value={50} max={50} />
          </div>
        </div>
      </Section>
    </>
  );
}

function FeedbackDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Feedback and Dialog">
      <div className={grid}>
        <State name="Pills">
          <div className="flex flex-wrap gap-2">
            <Pill>Neutral</Pill>
            <Pill tone="brand">Brand</Pill>
            <Pill tone="success">Success</Pill>
            <Pill tone="scheduled">Scheduled</Pill>
            <Pill tone="danger">Danger</Pill>
          </div>
        </State>
        <State name="Skeleton and loading rows">
          <Skeleton className="h-6 w-40" />
          <LoadingRows label="Loading example" rows={2} />
        </State>
        <State name="Error notice">
          <ErrorNotice
            message="The list didn’t load."
            action={<Button variant="ghost">Try again</Button>}
          />
        </State>
        <State name="Empty state">
          <EmptyState title="No subscribers yet" action={<Button>Import subscribers</Button>}>
            Import a list or share your signup page.
          </EmptyState>
        </State>
        <State name="Dialog">
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Open dialog
          </Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Delete this post?"
            description="This can’t be undone."
            actions={
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => setOpen(false)}>
                  Delete dispatch
                </Button>
              </>
            }
          />
        </State>
      </div>
    </Section>
  );
}

export function KitPage() {
  return (
    <ToastProvider>
      <main id="main" className="mx-auto grid max-w-[1240px] gap-5 px-[22px] py-8">
        <div>
          <h1 className="page-title">UI kit</h1>
          <p className="mt-1 text-[14px] text-sub">
            Every @swarm/ui component in each of its states. Development builds only; the numbers
            are made up.
          </p>
        </div>
        <ButtonsDemo />
        <FieldsDemo />
        <TogglesDemo />
        <TabsDemo />
        <TableDemo />
        <ToastDemo />
        <DataDemo />
        <FeedbackDemo />
      </main>
    </ToastProvider>
  );
}
