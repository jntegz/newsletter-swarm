// The Starters group of the Templates page: the list from the API, who may use one, and the
// preview with its suggested subject.
import {
  starterTemplateSummaries,
  type Channel,
  type StarterTemplate,
  type StarterTemplateSummary,
} from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { starterTemplateQuery, starterTemplatesQuery } from '../api/flows';
import { StarterPreview, StarterTemplates } from './StarterTemplates';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => undefined,
}));

const channel = { id: 'ch_1', name: 'Field Notes', role: 'owner' } as Channel;
const summaries = starterTemplateSummaries();

function render(node: ReactNode, seed?: (client: QueryClient) => void) {
  const client = new QueryClient();
  seed?.(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const withList = (client: QueryClient, list: StarterTemplateSummary[] = summaries) =>
  client.setQueryData(starterTemplatesQuery(channel.id).queryKey, list);

describe('the Starters group', () => {
  it('says it is loading before the list arrives, under its heading', () => {
    const html = render(<StarterTemplates channel={channel} canWrite />);
    expect(html).toContain('>Starters</h2>');
    expect(html).toContain('Loading starters');
    expect(html).not.toContain('<li');
  });

  it('lists every starter with its description, a Use button and a Preview button', () => {
    const html = render(<StarterTemplates channel={channel} canWrite />, withList);
    expect(html.match(/<li/g)).toHaveLength(summaries.length);
    for (const starter of summaries) {
      const name = starter.name.replace(/&/g, '&amp;');
      expect(html).toContain(`>${name}</h3>`);
      expect(html).toContain(`Use<span class="sr-only"> ${name}</span>`);
      expect(html).toContain(`Preview<span class="sr-only"> of ${name}</span>`);
    }
    expect(html).toContain('A short note in your own voice');
    // Nothing is previewed until asked for.
    expect(html).not.toContain('<iframe');
    expect(html).toContain('aria-expanded="false"');
  });

  it('lets a viewer look but not start a draft', () => {
    const html = render(<StarterTemplates channel={channel} canWrite={false} />, withList);
    expect(html).toContain('Preview<span');
    expect(html).not.toContain('Use<span');
  });

  it('speaks the dashboard’s words, not the internal ones', () => {
    const html = render(<StarterTemplates channel={channel} canWrite />, withList);
    expect(html).not.toMatch(/\b(Dispatch|Broadcast|Member|Channel|Flow)s?\b/);
  });
});

describe('a starter’s preview', () => {
  const starter = summaries.find((s) => s.key === 'welcome')!;

  it('shows the suggested subject and preview text while the email loads', () => {
    const html = render(<StarterPreview channel={channel} starter={starter} />);
    expect(html).toContain('Welcome issue: preview');
    expect(html).toContain('Suggested subject');
    expect(html).toContain(starter.subject);
    expect(html).toContain('Loading the preview');
    expect(html).not.toContain('<iframe');
  });

  it('shows the email in a sandboxed frame, with the publication named', () => {
    const html = render(<StarterPreview channel={channel} starter={starter} />, (client) =>
      client.setQueryData(starterTemplateQuery(channel.id, 'welcome').queryKey, {
        ...starter,
        content: { type: 'doc', content: [] },
        html: '<p>Hi there,</p><script>alert(1)</script>',
      } satisfies StarterTemplate),
    );
    expect(html).toContain('<iframe title="Email preview of Welcome issue" sandbox=""');
    expect(html).toContain('srcDoc="&lt;p&gt;Hi there,&lt;/p&gt;');
    expect(html).toContain('the email design of Field Notes');
    expect(html).not.toContain('Loading the preview');
  });
});
