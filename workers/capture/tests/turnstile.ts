/** Controls the mocked Turnstile siteverify response (see setup.ts). */
export const turnstile = {
  pass: true,
  hostname: 'forms.swarm.test',
  /** The data-cdata siteverify reports; undefined leaves it out. */
  cdata: undefined as string | undefined,
  calls: 0,
};
