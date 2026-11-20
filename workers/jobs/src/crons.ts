// The cron strings in wrangler.jsonc (every environment). They live outside index.ts because the
// Workers runtime treats every named export of the entry module as an entrypoint, and refuses to
// start when one is a plain value.

/** The daily cron. */
export const DAILY_CRON = '30 3 * * *';

/** The every-minute cron: the Flows sweep. */
export const MINUTE_CRON = '* * * * *';
