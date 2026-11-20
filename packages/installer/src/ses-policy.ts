/**
 * The reasons SES's account-level suppression list should add addresses for: hard bounces only.
 * The list is shared by every workspace on the install, so a complaint (about one workspace's
 * mail) must not stop another workspace's sends (docs/deliverability.md "Suppressions").
 */
export const SES_SUPPRESSED_REASONS = ['BOUNCE'];

/**
 * True when the account's list is not set to bounces only: it also adds addresses for complaints,
 * or it is off (no reasons), so SES would not add a hard-bounced address by itself.
 */
export const sesSuppressionOutdated = (reasons: readonly string[] | undefined) =>
  (reasons ?? []).join(',') !== SES_SUPPRESSED_REASONS.join(',');

/** The IAM actions the workers need, exactly as docs/deployment.md (Mail §4) lists them. */
export const WORKER_SES_ACTIONS = [
  'ses:SendEmail',
  'ses:SendRawEmail',
  'ses:GetAccount',
  'ses:CreateEmailIdentity',
  'ses:GetEmailIdentity',
  'ses:DeleteEmailIdentity',
  'ses:PutEmailIdentityMailFromAttributes',
  'ses:CreateConfigurationSet',
  'ses:CreateConfigurationSetEventDestination',
  'ses:PutConfigurationSetDeliveryOptions',
  'ses:CreateDedicatedIpPool',
  'ses:GetDedicatedIps',
  'ses:PutSuppressedDestination',
  'ses:DeleteSuppressedDestination',
  'ses:ListSuppressedDestinations',
];

/**
 * What a person can give the setup key instead of administrator access, limited to names starting
 * `swarm-`. iam:PutUserPolicy still makes it a powerful key, so the page says to delete it after.
 * docs/setup-guide.md shows the same policy.
 */
export const SES_SETUP_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        'ses:GetAccount',
        'ses:PutAccountDetails',
        'ses:PutAccountSuppressionAttributes',
        'ses:GetConfigurationSet',
        'ses:CreateConfigurationSet',
        'ses:GetConfigurationSetEventDestinations',
        'ses:CreateConfigurationSetEventDestination',
        'ses:GetEmailIdentity',
        'ses:CreateEmailIdentity',
        'ses:PutEmailIdentityMailFromAttributes',
      ],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: [
        'sns:CreateTopic',
        'sns:SetTopicAttributes',
        'sns:Subscribe',
        'sns:ListSubscriptionsByTopic',
      ],
      Resource: 'arn:aws:sns:*:*:swarm-*',
    },
    {
      Effect: 'Allow',
      Action: [
        'iam:GetUser',
        'iam:CreateUser',
        'iam:PutUserPolicy',
        'iam:ListAccessKeys',
        'iam:CreateAccessKey',
      ],
      Resource: 'arn:aws:iam::*:user/swarm-*',
    },
  ],
};

/**
 * The signature version the events worker accepts (verifySnsMessage in @swarm/engine). SNS topics
 * use version 1 unless told otherwise, and the worker refuses that, so nothing would ever confirm.
 */
export const SNS_SIGNATURE_VERSION = '2';

/** Whether the topic may still sign with a version the events worker refuses. */
export function sesTopicOutdated(ses: { topicSignatureVersion?: string | undefined }): boolean {
  return ses.topicSignatureVersion !== SNS_SIGNATURE_VERSION;
}

/**
 * Whether the workers' IAM policy lacks an action. An install saved before the actions were
 * recorded counts as out of date, so it gets the policy once more.
 */
export function sesPolicyOutdated(ses: { workerActions?: string[] | undefined }): boolean {
  const applied = new Set(ses.workerActions ?? []);
  return WORKER_SES_ACTIONS.some((action) => !applied.has(action));
}
