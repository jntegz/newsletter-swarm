/**
 * Prefixed, time-ordered ids: `<prefix>_<uuidv7 without dashes>`.
 * The prefix makes an id self-describing in logs and URLs; UUIDv7 keeps inserts index-friendly.
 */
const ID_PREFIXES = {
  workspace: 'ws',
  operator: 'op',
  seat: 'st',
  channel: 'ch',
  channelRole: 'cr',
  session: 'ss',
  quickpass: 'qp',
  oauthIdentity: 'oi',
  auditEvent: 'ae',
  featureFlag: 'ff',
  media: 'md',
  invite: 'in',
  member: 'mb',
  suppression: 'sp',
  /** One address's bounce counters in a workspace (bounce_states, 0067). */
  bounceState: 'bn',
  sendingDomain: 'sd',
  senderIdentity: 'si',
  dispatch: 'dp',
  dispatchRevision: 'dr',
  reputationRamp: 'rr',
  broadcast: 'bc',
  delivery: 'dl',
  linkTarget: 'lt',
  click: 'ck',
  open: 'on',
  memberField: 'mf',
  tag: 'tg',
  captureForm: 'cf',
  appConnection: 'ac',
  confirmRequest: 'cq',
  referral: 'rf',
  circle: 'cl',
  importJob: 'ij',
  exportJob: 'ej',
  bulkJob: 'bj',
  siteSection: 'sx',
  sitePage: 'pg',
  siteRedirect: 'rd',
  customHostname: 'hn',
  membershipLevel: 'lv',
  levelPrice: 'lp',
  memberSubscription: 'ms',
  payment: 'py',
  coupon: 'cp',
  compGrant: 'cg',
  giftPass: 'gp',
  pledge: 'pl',
  meterGrant: 'mg',
  // Phase 6 (member_events uses an integer `seq`, not a prefixed id)
  flow: 'fl',
  flowRun: 'fr',
  template: 'tp',
  snippet: 'sn',
  splitTest: 'xt',
  splitTestVariant: 'xv',
  cohortSample: 'cs',
  championReward: 'cw',
  championMilestone: 'cm',
  championAward: 'aw',
  ask: 'ak',
  askQuestion: 'aq',
  askOption: 'ao',
  askResponse: 'ar',
  signupJourney: 'sj',
  series: 'se',
  // Phase 7
  apiKey: 'ky',
  oauthApp: 'oa',
  oauthGrant: 'og',
  oauthToken: 'ot',
  webhookEndpoint: 'wh',
  webhookDelivery: 'wd',
  webhookEvent: 'ev',
  directSend: 'dn',
  dsrRequest: 'pr',
  passkey: 'pk',
  webauthnChallenge: 'wc',
  recoveryCode: 'rc',
  ssoConnection: 'so',
  ssoDomain: 'sv',
  dmarcReport: 'dm',
  dmarcRecord: 'dc',
  exportDestination: 'xd',
  // Phase 8 parity extras
  roster: 'rs',
  feedSource: 'fd',
  feedItem: 'fi',
  hubLink: 'lk',
  copilotRequest: 'ai',
  modelKey: 'mk',
  agentAction: 'ag',
  agentApproval: 'aa',
  appListing: 'al',
  recipeSubmission: 'rp',
  good: 'gd',
  goodPrice: 'gv',
  goodFile: 'gf',
  goodOrder: 'go',
  goodLicense: 'gl',
  partnerPick: 'pc',
  sponsorSlot: 'sl',
  sponsorBooking: 'bk',
  /** A check of a list's addresses with DeBounce (email_check_runs, 0068). */
  emailCheckRun: 'vr',
  // Nov 2026
  memberView: 'mv',
  siteDesignVersion: 'dv',
  /** An operator's own account security event (account_events, 0110). */
  accountEvent: 'ax',
  /** A stored "Check again" request for one subscriber's address (email_check_requests, 0112). */
  emailCheckRequest: 'eq',
  /** One change to an install-wide setting (instance_audit_events, 0113). */
  instanceAuditEvent: 'ie',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${uuidv7Hex(now)}`;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{32}$`);
}

/** RFC 9562 UUIDv7 as 32 lowercase hex characters. */
export function uuidv7Hex(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
