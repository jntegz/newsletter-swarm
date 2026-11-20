/** Controls the mocked Turnstile siteverify response (see setup.ts). */
export const turnstile: { pass: boolean; action: string | undefined } = {
  pass: true,
  action: 'quickpass',
};
