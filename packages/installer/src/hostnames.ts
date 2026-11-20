import type { EnvName, Worker } from './paths';
import type { Features } from './state';

/** The addresses a person chose. Anything left out keeps its default. */
interface Addresses {
  /** The dashboard's subdomain. Default: app. */
  dashboard?: string | undefined;
  /** The first publication lives at the domain itself, as its landing page. */
  publicationAtRoot?: boolean | undefined;
}

export interface Hostnames {
  zone: string;
  /** The first publication's website is the domain itself. */
  root: boolean;
  app: string;
  forms: string;
  link: string;
  media: string;
  events: string;
  /** Custom-domain fallback origin (SITE_FALLBACK_ORIGIN); used once custom domains are on. */
  sites: string;
  /** Channel sites live at <slug>.<siteDomain>; the free certificate covers one level. */
  siteDomain: string;
  /** Whether this environment owns the *.zone wildcard (production only). */
  wildcard: boolean;
  mail: string;
  mailFrom: string;
  bounce: string;
  unsubscribe: string;
  dmarc: string;
}

/**
 * Every hostname for one environment in zone D. Production uses app.D, forms.D…; staging puts
 * "staging-" in front (staging-app.D) so every name stays one level deep under the zone's
 * certificate. Staging does not get Channel sites: the *.D wildcard belongs to production.
 */
export function hostnamesFor(zone: string, env: EnvName, addresses?: Addresses): Hostnames {
  const host = (label: string) =>
    env === 'production' ? `${label}.${zone}` : `staging-${label}.${zone}`;
  const mail = host('mail');
  return {
    zone,
    root: env === 'production' && addresses?.publicationAtRoot === true,
    app: host(addresses?.dashboard ?? 'app'),
    forms: host('forms'),
    link: host('link'),
    media: host('media'),
    events: host('events'),
    sites: host('sites'),
    siteDomain: zone,
    wildcard: env === 'production',
    mail,
    mailFrom: `signin@${mail}`,
    bounce: `bounce.${mail}`,
    unsubscribe: host('unsubscribe'),
    dmarc: host('dmarc'),
  };
}

interface Route {
  pattern: string;
  zone_name: string;
}

/**
 * Zone routes for each worker. A Worker route beats a Custom Domain on the same hostname, so every
 * host is a plain route and the most specific pattern wins: app.D/* over *.D/*.
 */
export function routesFor(worker: Worker, h: Hostnames, features: Features): Route[] {
  const route = (host: string): Route => ({ pattern: `${host}/*`, zone_name: h.zone });
  switch (worker) {
    case 'api':
      return [route(h.app)];
    case 'capture':
      return [route(h.forms)];
    case 'track':
      return [route(h.link)];
    case 'events':
      return [route(h.events)];
    case 'site': {
      const routes = [route(h.media)];
      if (h.root) routes.push(route(h.zone));
      // With custom domains on, */* catches every custom hostname on the SaaS zone as well.
      if (h.wildcard) routes.push(features.customDomains ? route('*') : route(`*.${h.zone}`));
      return routes;
    }
    default:
      return [];
  }
}

/**
 * Hosts that need a proxied DNS record so their route is reached. AAAA 100:: is the documented
 * "originless" address for Worker-only hostnames.
 */
export function proxiedHosts(h: Hostnames, features: Features): string[] {
  const hosts = [h.app, h.forms, h.link, h.media, h.events];
  if (h.wildcard) hosts.push(`*.${h.zone}`);
  if (features.customDomains) hosts.push(h.sites);
  return hosts;
}

/** The hostname table shown before anything is created. */
export function hostnameTable(h: Hostnames): [string, string][] {
  const rows: [string, string][] = [
    [h.app, 'Dashboard and API'],
    [h.forms, 'Signup forms and subscriber pages'],
    [h.link, 'Click and open tracking'],
    [h.media, 'Images and files'],
    [h.events, 'Mail delivery events'],
  ];
  if (h.root) rows.push([h.zone, 'Your publication: its landing page and past posts']);
  if (h.wildcard) rows.push([`<publication>.${h.zone}`, 'Publication websites']);
  rows.push(
    [h.mail, 'Sending domain (From: ' + h.mailFrom + ')'],
    [h.unsubscribe, 'Unsubscribe by email'],
    [h.dmarc, 'DMARC reports'],
  );
  return rows;
}
