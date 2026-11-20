import { resolve } from '../commands/doctor';
import { configurationSet } from '../config/render';
import { hostnamesFor } from '../hostnames';
import type { Ctx } from '../context';
import { MailgunRest } from '../mailgun';
import { PostmarkRest } from '../postmark';
import { ResendRest } from '../resend';
import type { Step } from '../steps/step';
import { InstallError } from '../ui';

const SUBJECT = 'Your Swarm install can send email';
const BODY =
  'This test email came from your new Swarm install, through your own email service. You can delete it.';

const notVerified = (service: string, domain: string) =>
  new InstallError(
    `${service} hasn't verified ${domain} yet, so Swarm can't send email, including your sign-in link.`,
    `DNS changes can take a few minutes, and sometimes longer. Wait 10 minutes, then try this step again. If it keeps stopping here, see "The install stops at Checking email works" in the setup guide.`,
  );

/**
 * Checks with the Workers' own key, so this also proves the key they'll send with. Returns how to
 * send the test email. In the SES sandbox, the owner's address has to be verified as well.
 */
async function checkSes(ctx: Ctx, domain: string, from: string, owner: string, region: string) {
  const credentials = ctx.secrets.aws;
  if (!credentials || !ctx.state.ses) throw new InstallError('The Amazon SES setup is missing.');
  const verified = async (identity: string) => {
    try {
      const found = await ctx.t.aws<{ VerifiedForSendingStatus?: boolean }>({
        service: 'sesv2',
        operation: 'GetEmailIdentity',
        input: { EmailIdentity: identity },
        region,
        credentials,
      });
      return found.VerifiedForSendingStatus === true;
    } catch (error) {
      if (/NotFound/.test((error as Error).name)) return false;
      throw error;
    }
  };
  if (!(await verified(domain))) throw notVerified('Amazon SES', domain);
  if (!ctx.state.ses.productionAccess) {
    ctx.report.mailNote =
      "Amazon SES has your account in its sandbox, so email only reaches addresses you've verified, and at most 200 a day. Subscribers won't get your posts until AWS approves production access, which a person at AWS reviews, usually within a day.";
    if (!(await verified(owner))) {
      throw new InstallError(
        `Amazon SES can't send to ${owner} until you click the link it sent you.`,
        'Look for an email from Amazon Web Services, and check spam. Click the link in it, then try this step again.',
      );
    }
  }
  return () =>
    ctx.t
      .aws<unknown>({
        service: 'sesv2',
        operation: 'SendEmail',
        input: {
          FromEmailAddress: from,
          Destination: { ToAddresses: [owner] },
          ConfigurationSetName: configurationSet(ctx.env, 'transactional'),
          Content: { Simple: { Subject: { Data: SUBJECT }, Body: { Text: { Data: BODY } } } },
        },
        region,
        credentials,
      })
      .then(() => undefined);
}

/**
 * Proves email works before the install calls itself finished: the sending domain is verified, and
 * the service accepts a real email to the owner. Without this, an install can look perfect and then
 * fail at the very first sign-in, with nothing to explain why.
 */
export const emailCheck: Step = {
  id: 'email-check',
  title: 'Checking email works',
  async run(ctx: Ctx) {
    const choices = ctx.state.choices;
    if (!choices) throw new InstallError('Answers are missing.');
    const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, choices.addresses);
    const owner = choices.owner.email;
    const provider = choices.mail.provider;
    let send: (() => Promise<void>) | null = null;

    if (provider === 'resend') {
      const id = ctx.state.resend?.domainId;
      if (!ctx.secrets.resendApiKey || !id) throw new InstallError('The Resend domain is missing.');
      const api = new ResendRest(ctx.t, ctx.secrets.resendApiKey);
      await api.verifyDomain(id);
      const { status } = await api.getDomain(id);
      ctx.state.resend = { ...ctx.state.resend, domainId: id, status };
      if (status !== 'verified') throw notVerified('Resend', h.mail);
      send = () => api.sendEmail(h.mailFrom, owner, SUBJECT, BODY);
    } else if (provider === 'mailgun') {
      const domain = ctx.state.mailgun?.domain;
      if (!ctx.secrets.mailgunApiKey || !domain)
        throw new InstallError('The Mailgun domain is missing.');
      const api = new MailgunRest(
        ctx.t,
        ctx.secrets.mailgunApiKey,
        choices.mail.region as 'us' | 'eu',
      );
      const state = (await api.verifyDomain(domain)).domain?.state;
      if (state !== 'active') throw notVerified('Mailgun', h.mail);
      send = () => api.sendEmail(domain, h.mailFrom, owner, SUBJECT, BODY);
    } else if (provider === 'postmark') {
      const account = ctx.secrets.postmarkAccountToken;
      const server = ctx.secrets.postmarkServerToken;
      const id = ctx.state.postmark?.domainId;
      if (!account || !server || !id) throw new InstallError('The Postmark domain is missing.');
      const api = new PostmarkRest(ctx.t, { account, server });
      if (!(await api.verifyDkim(id)).DKIMVerified) throw notVerified('Postmark', h.mail);
      send = () => api.sendEmail(h.mailFrom, owner, SUBJECT, BODY);
    } else if (provider === 'smtp') {
      const selector = choices.mail.smtp?.dkimSelector ?? '';
      const name = `${selector}._domainkey.${h.mail}`;
      const found = await resolve(ctx, name, 'TXT');
      if (!found.some((value) => /(^|;)\s*p=[^;\s]/.test(value))) {
        throw new InstallError(
          `Swarm can't find the DKIM record at ${name}.`,
          'Publish the DKIM record your mail server gives you, then try this step again.',
        );
      }
    } else if (provider === 'ses') {
      send = await checkSes(ctx, h.mail, h.mailFrom, owner, choices.mail.region);
    } else {
      // Passing here would call an install finished without having checked anything.
      throw new InstallError(`Swarm can't check email for "${String(provider)}".`);
    }

    if (send) {
      await ctx.ui.task(`Sending a test email to ${owner}`, async () => {
        try {
          await (send as () => Promise<void>)();
        } catch (error) {
          throw new InstallError(
            `Your email service refused a test email: ${(error as Error).message}`,
            "Check the service's dashboard for why, such as a free plan's limits or an account waiting for approval. Then try this step again.",
          );
        }
      });
    }
    ctx.report.testEmailTo = send ? owner : undefined;
  },
};
