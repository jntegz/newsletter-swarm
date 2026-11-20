/**
 * Classifies opens and clicks. The classification is stored with the event and never used to
 * drop it, so the rules can change later and history can be re-read.
 */

export type OpenClass = 'human' | 'machine_open' | 'bot';
export type ClickClass = 'human' | 'scanner' | 'bot';

export interface RequestSignals {
  method: string;
  userAgent: string | null;
  /** request.cf.asn */
  asn: number | null;
  /** request.cf.asOrganization */
  asOrganization: string | null;
}

/** Security gateways and link scanners that fetch every URL in a message. */
const SCANNER_UA =
  /(bot\b|crawler|spider|preview|scanner|barracuda|proofpoint|mimecast|messagelabs|symantec|trend ?micro|forcepoint|fireeye|cisco|ironport|sophos|python-requests|python-urllib|curl\/|wget\/|go-http-client|java\/|okhttp|headless|phantomjs|axios\/|node-fetch|libwww|httpclient)/i;

/** Networks that belong to mail security vendors or cloud scanners (clicks only). */
const SCANNER_ASNS = new Set([
  8075, // Microsoft (Defender for Office 365 Safe Links)
  22843, // Proofpoint
  26211, // Proofpoint
  30031, // Mimecast
  15324, // Barracuda
  21342, // Akamai link scanning
  14618, // Amazon AWS
  16509, // Amazon AWS
  396982, // Google Cloud
]);

/** Apple's Mail Privacy Protection relays (iCloud Private Relay egress and Apple proxies). */
const APPLE_ASNS = new Set([714, 6185]);

export function uaFamily(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (!ua) return 'none';
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'gmail_proxy';
  if (/YahooMailProxy/i.test(ua)) return 'yahoo_proxy';
  if (SCANNER_UA.test(ua)) return 'bot';
  if (/Microsoft Outlook|ms-office|Outlook-iOS|Outlook-Android/i.test(ua)) return 'outlook';
  if (/Thunderbird/i.test(ua)) return 'thunderbird';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  if (/AppleWebKit/.test(ua) && /Mac OS X|iPhone|iPad/.test(ua)) return 'apple_mail';
  return 'other';
}

const isApple = (s: RequestSignals) =>
  (s.asn !== null && APPLE_ASNS.has(s.asn)) || /\bapple\b/i.test(s.asOrganization ?? '');

/** A bare "Mozilla/5.0" with no platform details is what Apple's proxy sends. */
const isGenericUa = (ua: string | null) => !ua || /^Mozilla\/5\.0$/.test(ua.trim());

export function classifyOpen(signals: RequestSignals): OpenClass {
  if (signals.method === 'HEAD') return 'bot';
  const family = uaFamily(signals.userAgent);
  // Gmail fetches images through its proxy only when the message is opened: a real open.
  if (family === 'gmail_proxy' || family === 'yahoo_proxy') return 'human';
  if (isApple(signals) && isGenericUa(signals.userAgent)) return 'machine_open';
  if (family === 'bot' || family === 'none') return 'bot';
  return 'human';
}

export interface ClickContext {
  /** When the message was handed to the provider. */
  sentAt: number;
  now: number;
  /** Other clicks on this delivery in the last second. */
  clicksInLastSecond: number;
}

export function classifyClick(signals: RequestSignals, context: ClickContext): ClickClass {
  if (signals.method === 'HEAD') return 'bot';
  const family = uaFamily(signals.userAgent);
  if (family === 'bot' || family === 'none') return 'bot';
  if (signals.asn !== null && SCANNER_ASNS.has(signals.asn)) return 'scanner';
  // People don't click within two seconds of delivery, or several links in the same second.
  if (context.now - context.sentAt < 2000) return 'scanner';
  if (context.clicksInLastSecond > 0) return 'scanner';
  return 'human';
}
