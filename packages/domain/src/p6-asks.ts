// Ask (polls and surveys), Signup Journeys and Smart Prompts (Phase 6): request and response
// schemas for the dashboard API, plus the token contracts the capture and site workers share.
// Enums, limits and the step and placement schemas live in p6-growth.ts.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import {
  ASK_KINDS,
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ASK_QUESTION_KINDS,
  ASK_STATUSES,
  ASK_SURFACES,
  SignupJourneyVariantsSchema,
} from './p6-growth';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Tokens

/**
 * The survey page (`/_swarm/ask/:id` on the site) needs to know who answers: a signed-in reader,
 * or this link. Purpose 'ask-page', payload `{ m: memberId, a: askId, c: channelId }`, 7 days,
 * signed with ASK_PAGE_SIGNING_KEYS (capture; the site checks the public key). Issued after a one-tap answer (to finish a survey) and never accepted for another
 * Ask; an 'ask' poll token is refused here and this token is refused at `/a/:token`.
 */
export const ASK_PAGE_TOKEN_PURPOSE = 'ask-page';
export const ASK_PAGE_TOKEN_LIFETIME_DAYS = 7;

/** Placeholder for a one-tap poll link in a rendered email template: `{{@ask:<optionId>}}`. */
export const ASK_PLACEHOLDER = /\{\{@ask:(ao_[0-9a-f]{32})\}\}/g;

/** The editor block: `{ type: 'askPoll', attrs: { askId, questionId } }`, top level. */
export const ASK_POLL_NODE = 'askPoll';

// ---------------------------------------------------------------------------------------------
// Ask

const AskOptionInputSchema = z
  .object({
    /** Keep an option's id when editing, so its answers stay attached. */
    id: id('askOption').optional(),
    label: z.string().trim().min(1, 'Label the option.').max(120),
  })
  .openapi('AskOptionInput');

const AskQuestionInputSchema = z
  .object({
    id: id('askQuestion').optional(),
    prompt: z.string().trim().min(1, 'Write the question.').max(300),
    description: z.string().trim().max(1000).nullish(),
    kind: z.enum(ASK_QUESTION_KINDS),
    /**
     * Copies answers into this profile field of the Channel, so Circles can filter on them: a
     * select field for a choice question (every option label must be one of its choices), a text
     * field for a text question. Encrypted fields can't be used.
     */
    fieldId: id('memberField').nullish(),
    required: z.boolean().default(false),
    options: z.array(AskOptionInputSchema).max(ASK_MAX_OPTIONS).default([]),
  })
  .superRefine((q, ctx) => {
    if (q.kind === 'choice' && q.options.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give at least two options.' });
    }
    if (q.kind === 'text' && q.options.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Text questions have no options.',
      });
    }
    const labels = q.options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must differ.' });
    }
  })
  .openapi('AskQuestionInput');
export type AskQuestionInput = z.infer<typeof AskQuestionInputSchema>;

const questionsSchema = z.array(AskQuestionInputSchema).min(1).max(ASK_MAX_QUESTIONS);

export const CreateAskSchema = z
  .object({
    kind: z.enum(ASK_KINDS),
    title: z.string().trim().min(1, 'Give it a title.').max(200),
    description: z.string().trim().max(1000).nullish(),
    resultsPublic: z.boolean().default(true),
    closesAt: timestamp.nullish(),
    questions: questionsSchema,
  })
  .superRefine((ask, ctx) => {
    if (
      ask.kind === 'poll' &&
      (ask.questions.length !== 1 || ask.questions[0]?.kind !== 'choice')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'A poll has exactly one choice question.',
      });
    }
  })
  .openapi('CreateAsk');
export type CreateAsk = z.infer<typeof CreateAskSchema>;

export const UpdateAskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullish(),
    status: z.enum(ASK_STATUSES).optional(),
    resultsPublic: z.boolean().optional(),
    closesAt: timestamp.nullish(),
    /**
     * Replaces the questions. Pass existing ids to keep questions and options; a question or
     * option that already has answers can't be removed (409).
     */
    questions: questionsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateAsk');
export type UpdateAsk = z.infer<typeof UpdateAskSchema>;

const AskOptionSchema = z
  .object({ id: id('askOption'), label: z.string(), position: z.number().int() })
  .openapi('AskOption');

const AskQuestionSchema = z
  .object({
    id: id('askQuestion'),
    position: z.number().int(),
    prompt: z.string(),
    description: z.string().nullable(),
    kind: z.enum(ASK_QUESTION_KINDS),
    fieldId: id('memberField').nullable(),
    required: z.boolean(),
    options: z.array(AskOptionSchema),
  })
  .openapi('AskQuestion');
export const AskSchema = z
  .object({
    id: id('ask'),
    channelId: id('channel'),
    kind: z.enum(ASK_KINDS),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(ASK_STATUSES),
    resultsPublic: z.boolean(),
    closesAt: timestamp.nullable(),
    questions: z.array(AskQuestionSchema),
    /** Members who answered at least one question. */
    respondents: z.number().int(),
    /** The survey page on the Channel website. */
    surveyPath: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('Ask');
export type Ask = z.infer<typeof AskSchema>;

export const AskResultsSchema = z
  .object({
    askId: id('ask'),
    /** The Circle the counts are limited to, when asked for. */
    circleId: id('circle').nullable(),
    respondents: z.number().int(),
    questions: z.array(
      z.object({
        questionId: id('askQuestion'),
        prompt: z.string(),
        kind: z.enum(ASK_QUESTION_KINDS),
        answers: z.number().int(),
        options: z.array(
          z.object({ optionId: id('askOption'), label: z.string(), count: z.number().int() }),
        ),
      }),
    ),
  })
  .openapi('AskResults');
export type AskResults = z.infer<typeof AskResultsSchema>;

const AskTextAnswerSchema = z
  .object({
    memberId: id('member'),
    text: z.string(),
    surface: z.enum(ASK_SURFACES),
    answeredAt: timestamp,
  })
  .openapi('AskTextAnswer');

export const AskTextAnswersSchema = z
  .object({
    items: z.array(AskTextAnswerSchema),
    /** Pass as `cursor` for the next page; null at the end. */
    nextCursor: z.string().nullable(),
  })
  .openapi('AskTextAnswers');
export type AskTextAnswers = z.infer<typeof AskTextAnswersSchema>;

// ---------------------------------------------------------------------------------------------
// Signup Journeys

const SIGNUP_JOURNEY_STATUSES = ['draft', 'live', 'paused', 'archived'] as const;
export type SignupJourneyStatus = (typeof SIGNUP_JOURNEY_STATUSES)[number];

export const CreateSignupJourneySchema = z
  .object({
    name: z.string().trim().min(1, 'Name the journey.').max(80),
    /** One form, or null for every form of the Channel without a journey of its own. */
    formId: id('captureForm').nullish(),
    variants: SignupJourneyVariantsSchema,
  })
  .superRefine((value, ctx) => {
    const keys = value.variants.map((v) => v.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys must differ.' });
    }
  })
  .openapi('CreateSignupJourney');
export type CreateSignupJourney = z.infer<typeof CreateSignupJourneySchema>;

export const UpdateSignupJourneySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    formId: id('captureForm').nullish(),
    /** Live journeys are one per form: going live while another is live answers 409. */
    status: z.enum(SIGNUP_JOURNEY_STATUSES).optional(),
    variants: SignupJourneyVariantsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .superRefine((value, ctx) => {
    const keys = (value.variants ?? []).map((v) => v.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys must differ.' });
    }
  })
  .openapi('UpdateSignupJourney');
export type UpdateSignupJourney = z.infer<typeof UpdateSignupJourneySchema>;

export const SignupJourneySchema = z
  .object({
    id: id('signupJourney'),
    channelId: id('channel'),
    name: z.string(),
    status: z.enum(SIGNUP_JOURNEY_STATUSES),
    formId: id('captureForm').nullable(),
    variants: SignupJourneyVariantsSchema,
    /** The promoted variant: every new Member gets it. */
    winnerKey: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('SignupJourney');
export type SignupJourney = z.infer<typeof SignupJourneySchema>;

export const PromoteSignupJourneySchema = z
  .object({ variant: z.string().regex(/^[a-z]{1,8}$/) })
  .openapi('PromoteSignupJourney');

const stepCounts = {
  views: z.number().int(),
  completions: z.number().int(),
  skips: z.number().int(),
};

export const SignupJourneyStatsSchema = z
  .object({
    journeyId: id('signupJourney'),
    days: z.number().int(),
    variants: z.array(
      z.object({
        key: z.string(),
        steps: z.array(z.object({ step: z.number().int(), ...stepCounts })),
        /** Completions of the last step over views of the first, or null without views. */
        completionRate: z.number().nullable(),
      }),
    ),
    daily: z.array(
      z.object({ day: z.string(), variant: z.string(), step: z.number().int(), ...stepCounts }),
    ),
  })
  .openapi('SignupJourneyStats');
export type SignupJourneyStats = z.infer<typeof SignupJourneyStatsSchema>;
