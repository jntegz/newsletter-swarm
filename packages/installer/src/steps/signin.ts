import { signInLink } from './bootstrap';
import type { Step } from './step';

export const signin: Step = {
  id: 'signin',
  title: 'Sign-in link',
  async run(ctx) {
    ctx.report.signInLink = await signInLink(ctx);
  },
};
