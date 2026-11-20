import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BarChart,
  Checkbox,
  Donut,
  Kpi,
  LineChart,
  MAX_TOASTS,
  Progress,
  SelectField,
  Switch,
  Table,
  Tabs,
  TextField,
  ToastRegion,
  chartDomain,
  describeChart,
  donutDash,
  linePath,
  nextTabIndex,
  scaleLinear,
  share,
  toastDuration,
  toastReducer,
  type Toast,
} from './index';

const noop = () => {};

describe('nextTabIndex', () => {
  const none = [false, false, false];
  it('moves with the arrows and wraps', () => {
    expect(nextTabIndex(0, 'ArrowRight', none)).toBe(1);
    expect(nextTabIndex(2, 'ArrowRight', none)).toBe(0);
    expect(nextTabIndex(0, 'ArrowLeft', none)).toBe(2);
  });
  it('jumps with Home and End', () => {
    expect(nextTabIndex(1, 'Home', none)).toBe(0);
    expect(nextTabIndex(1, 'End', none)).toBe(2);
  });
  it('skips disabled tabs', () => {
    expect(nextTabIndex(0, 'ArrowRight', [false, true, false])).toBe(2);
    expect(nextTabIndex(1, 'Home', [true, false, false])).toBe(1);
    expect(nextTabIndex(0, 'End', [false, false, true])).toBe(1);
  });
  it('ignores other keys and empty lists', () => {
    expect(nextTabIndex(0, 'Enter', none)).toBeNull();
    expect(nextTabIndex(0, 'ArrowRight', [])).toBeNull();
  });
});

describe('Tabs', () => {
  it('puts only the selected tab in the Tab order and wires its panel', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Form"
        tabs={[
          { id: 'a', label: 'Build' },
          { id: 'b', label: 'Stats' },
        ]}
        value="b"
        onChange={noop}
        idFor={(id) => `tab-${id}`}
        panelFor={(id) => `panel-${id}`}
      />,
    );
    expect(html).toContain('role="tablist" aria-label="Form"');
    expect(html).toMatch(
      /id="tab-a"[^>]*aria-selected="false"[^>]*aria-controls="panel-a"[^>]*tabindex="-1"/,
    );
    expect(html).toMatch(/id="tab-b"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  });
});

describe('toastReducer', () => {
  const t = (id: number, message = `m${id}`, tone: Toast['tone'] = 'success'): Toast => ({
    id,
    message,
    tone,
  });
  it('adds, dismisses and clears', () => {
    let state = toastReducer([], { type: 'show', toast: t(1) });
    state = toastReducer(state, { type: 'show', toast: t(2) });
    expect(state.map((x) => x.id)).toEqual([1, 2]);
    state = toastReducer(state, { type: 'dismiss', id: 1 });
    expect(state.map((x) => x.id)).toEqual([2]);
    expect(toastReducer(state, { type: 'clear' })).toEqual([]);
  });
  it('replaces a duplicate instead of stacking it', () => {
    const state = toastReducer([t(1, 'Saved.')], { type: 'show', toast: t(2, 'Saved.') });
    expect(state).toEqual([t(2, 'Saved.')]);
  });
  it('keeps the newest few', () => {
    let state: Toast[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++)
      state = toastReducer(state, { type: 'show', toast: t(i) });
    expect(state).toHaveLength(MAX_TOASTS);
    expect(state[0]?.id).toBe(3);
  });
  it('keeps errors until they are dismissed', () => {
    expect(toastDuration('error')).toBeNull();
    expect(toastDuration('success')).toBeGreaterThan(0);
  });
  it('announces errors assertively and the rest politely', () => {
    const html = renderToStaticMarkup(
      <ToastRegion toasts={[t(1, 'Saved.'), t(2, 'Could not save.', 'error')]} onDismiss={noop} />,
    );
    expect(html).toMatch(
      /role="status" aria-live="polite".*Saved\..*role="alert"[^>]*>.*Could not save\./,
    );
    expect(html).toContain('aria-label="Dismiss"');
  });
});

describe('chart math', () => {
  it('scales linearly and centers a flat domain', () => {
    const y = scaleLinear([0, 10], [100, 0]);
    expect(y(0)).toBe(100);
    expect(y(5)).toBe(50);
    expect(scaleLinear([3, 3], [0, 10])(3)).toBe(5);
  });
  it('pads the domain, starts bars at zero and widens a flat one', () => {
    expect(chartDomain([10, 20])).toEqual([9, 21]);
    expect(chartDomain([10, 20], { zero: true })).toEqual([0, 22]);
    expect(chartDomain([5, 5])).toEqual([4, 6]);
    expect(chartDomain([])).toEqual([0, 1]);
  });
  it('breaks the line at gaps', () => {
    const d = linePath(
      [1, 2, null, 4],
      (i) => i * 10,
      (v) => v,
    );
    expect(d).toBe('M0.0,1.0 L10.0,2.0 M30.0,4.0');
  });
  it('describes every value for screen readers', () => {
    expect(
      describeChart(['Mon', 'Tue'], [{ label: 'Opens', values: [40, null] }], (v) => `${v}%`),
    ).toBe('Opens: Mon 40%, Tue no data');
  });
  it('computes shares and donut dashes', () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(5, 0)).toBe(0);
    expect(share(9, 4)).toBe(1);
    const { length, gap } = donutDash(0.25, 10);
    expect(length + gap).toBeCloseTo(2 * Math.PI * 10);
    expect(length).toBeCloseTo((2 * Math.PI * 10) / 4);
  });
});

describe('data components', () => {
  it('Kpi shows the value with a labelled delta, or an empty dash', () => {
    const html = renderToStaticMarkup(
      <Kpi label="Members" value="1,204" delta={{ label: '4%', direction: 'down', good: true }} />,
    );
    expect(html).toContain('1,204');
    expect(html).toContain('bg-success-soft');
    expect(html).toContain('Down');
    const empty = renderToStaticMarkup(
      <Kpi label="Opens" value="" empty="After your first Broadcast" />,
    );
    expect(empty).toContain('No data yet');
    expect(empty).toContain('After your first Broadcast');
  });
  it('charts render an accessible SVG, an empty state or a loading state', () => {
    const series = [{ label: 'Opens', values: [1, 2, 3] }];
    const line = renderToStaticMarkup(
      <LineChart title="Opens" labels={['a', 'b', 'c']} series={series} />,
    );
    expect(line).toContain('role="img"');
    expect(line).toContain('aria-label="Opens: a 1, b 2, c 3"');
    const bars = renderToStaticMarkup(
      <BarChart title="Opens" labels={['a', 'b', 'c']} series={series} />,
    );
    expect(bars.match(/<rect/g)).toHaveLength(3);
    expect(
      renderToStaticMarkup(
        <LineChart title="Opens" labels={[]} series={[]} empty="Nothing sent yet" />,
      ),
    ).toContain('Nothing sent yet');
    expect(
      renderToStaticMarkup(<BarChart title="Opens" labels={[]} series={[]} loading />),
    ).toContain('Loading chart');
  });
  it('Donut and Progress expose their values', () => {
    expect(renderToStaticMarkup(<Donut label="Opened" value={1} total={4} />)).toContain(
      'aria-label="Opened: 25% (1 of 4)"',
    );
    const progress = renderToStaticMarkup(<Progress label="Completed" value={30} max={120} />);
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow="30"');
    expect(progress).toContain('width:25%');
  });
});

describe('controls', () => {
  it('Checkbox is a native input tied to its label, hint and error', () => {
    const html = renderToStaticMarkup(
      <Checkbox label="Public" hint="Shown on the site" error="Pick one" checked onChange={noop} />,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toMatch(/aria-describedby="[^"]+-hint [^"]+-error"/);
    expect(html).toContain('aria-invalid="true"');
  });
  it('TextField and SelectField keep their height unless asked for the toolbar size', () => {
    const options = [{ value: 'a', label: 'A' }];
    expect(renderToStaticMarkup(<TextField label="Search" />)).toContain('min-h-[40px]');
    const small = renderToStaticMarkup(<TextField label="Search" size="sm" />);
    expect(small).toContain('min-h-[36px]');
    expect(small).not.toContain('min-h-[40px]');
    expect(small).not.toContain('size=');
    expect(renderToStaticMarkup(<SelectField label="Tag" options={options} />)).toContain(
      'min-h-[40px]',
    );
    expect(renderToStaticMarkup(<SelectField label="Tag" size="sm" options={options} />)).toMatch(
      /<select[^>]*min-h-\[36px\]/,
    );
  });
  it('a hidden label stays for assistive technology', () => {
    const html = renderToStaticMarkup(<TextField label="Search" hideLabel placeholder="Email" />);
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>Search<\/label>/);
  });
  it('Switch is a switch with its state', () => {
    const html = renderToStaticMarkup(
      <Switch label="Track opens" checked={false} onChange={noop} />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(renderToStaticMarkup(<Switch label="x" checked loading onChange={noop} />)).toContain(
      'aria-busy="true"',
    );
  });
  it('Table renders rows, a loading state and an empty state', () => {
    const columns = [
      { key: 'name', header: 'Name', cell: (r: { n: string; v: number }) => r.n, rowHeader: true },
      {
        key: 'v',
        header: 'Opens',
        cell: (r: { n: string; v: number }) => r.v,
        align: 'right' as const,
      },
    ];
    const html = renderToStaticMarkup(
      <Table
        caption="Dispatches"
        columns={columns}
        rows={[{ n: 'One', v: 3 }]}
        rowKey={(r) => r.n}
      />,
    );
    expect(html).toContain('<caption class="sr-only">Dispatches</caption>');
    expect(html).toContain('scope="row"');
    expect(
      renderToStaticMarkup(
        <Table
          caption="Dispatches"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.n}
          empty="None yet"
        />,
      ),
    ).toContain('None yet');
    expect(
      renderToStaticMarkup(
        <Table
          caption="Dispatches"
          columns={columns}
          rows={undefined}
          rowKey={(r) => r.n}
          loading
        />,
      ),
    ).toContain('Loading Dispatches');
  });
});
