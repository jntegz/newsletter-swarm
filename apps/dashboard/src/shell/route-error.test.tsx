// The page that takes a failed page's place, and the one for an address that matches no page.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteError, RouteNotFound, reportRouteError } from './RouteError';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

afterEach(() => vi.restoreAllMocks());

describe('the route error page', () => {
  const html = render(<RouteError error={new Error('from is undefined')} reset={() => {}} />);

  it('has a heading and both ways out', () => {
    expect(html).toMatch(/<h1[^>]*>This page didn’t load<\/h1>/);
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toContain('<a href="/" class="btn-ghost btn-sm">Go to Home</a>');
  });

  it('speaks calmly and keeps the technical message out of the page', () => {
    expect(text(html)).not.toContain('!');
    expect(text(html)).not.toContain('from is undefined');
  });

  it('reports the error to the console', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    reportRouteError(error);
    expect(log).toHaveBeenCalledWith(expect.any(String), error);
  });
});

describe('the not found page', () => {
  it('names the problem and links home', () => {
    const html = render(<RouteNotFound />);
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(html).toContain('Go to Home');
  });
});
