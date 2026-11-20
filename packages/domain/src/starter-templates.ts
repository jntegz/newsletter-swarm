// Starter templates: newsletter starting points that ship with Swarm, defined in code so a fresh
// install has them with no seeding step. The Template Library lists them beside the templates a
// team saved itself. Using one creates an ordinary draft Dispatch with the starter's subject,
// preview text and content; the starter itself is never edited or stored per workspace.
//
// The sample copy is instructive: every paragraph says what belongs there, in the voice a writer
// might use, so a starter reads like a finished issue and still tells its writer what to replace.
// Links point at example.com on purpose. Only blocks every install can send are used (no raw
// HTML, no flag-gated blocks), and the tests render each one through the email renderer.
import { z } from '@hono/zod-openapi';
import { DispatchDocumentSchema, type DispatchDocument } from './send';

export const STARTER_TEMPLATE_KEYS = [
  'personal-letter',
  'weekly-roundup',
  'essay',
  'announcement',
  'interview',
  'product-update',
  'paid-invitation',
  'welcome',
] as const;
export type StarterTemplateKey = (typeof STARTER_TEMPLATE_KEYS)[number];
export const StarterTemplateKeySchema = z.enum(STARTER_TEMPLATE_KEYS).openapi('StarterTemplateKey');

export const StarterTemplateSummarySchema = z
  .object({
    key: StarterTemplateKeySchema,
    name: z.string(),
    /** One line on when to reach for it. */
    description: z.string(),
    subject: z.string().openapi({ description: 'A suggested subject, to be replaced' }),
    preheader: z.string().openapi({ description: 'Suggested preview text, to be replaced' }),
  })
  .openapi('StarterTemplateSummary');
export type StarterTemplateSummary = z.infer<typeof StarterTemplateSummarySchema>;

export const StarterTemplateSchema = StarterTemplateSummarySchema.extend({
  content: DispatchDocumentSchema,
  html: z.string().openapi({
    description: 'The starter as an email in this Channel’s design, without personalisation',
  }),
}).openapi('StarterTemplate');
export type StarterTemplate = z.infer<typeof StarterTemplateSchema>;

interface StarterTemplateDef extends StarterTemplateSummary {
  content: DispatchDocument;
}

// ---- Document builders -----------------------------------------------------------------------

type Block = Record<string, unknown>;
type Inline = string | Record<string, unknown>;

const text = (value: string, ...marks: Record<string, unknown>[]) => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks } : {}),
});
const b = (value: string) => text(value, { type: 'bold' });
const i = (value: string) => text(value, { type: 'italic' });
const a = (value: string, href: string) => text(value, { type: 'link', attrs: { href } });
const inline = (parts: Inline[]) =>
  parts.map((part) => (typeof part === 'string' ? text(part) : part));

const p = (...parts: Inline[]): Block => ({ type: 'paragraph', content: inline(parts) });
const h = (level: 1 | 2 | 3, value: string): Block => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const ul = (...items: Inline[][]): Block => ({
  type: 'bulletList',
  content: items.map((parts) => ({ type: 'listItem', content: [p(...parts)] })),
});
const quote = (...blocks: Block[]): Block => ({ type: 'blockquote', content: blocks });
const callout = (...blocks: Block[]): Block => ({ type: 'callout', content: blocks });
const hr = (): Block => ({ type: 'horizontalRule' });
const button = (label: string, href: string): Block => ({ type: 'button', attrs: { label, href } });
const card = (title: string, description: string, href: string): Block => ({
  type: 'linkCard',
  attrs: { title, description, href },
});
const columns = (left: Block[], right: Block[]): Block => ({
  type: 'columns',
  content: [
    { type: 'column', content: left },
    { type: 'column', content: right },
  ],
});
const doc = (...content: Block[]): DispatchDocument => ({ type: 'doc', content });

/** Merge tag for the reader's first name, with a fallback for readers who never gave one. */
const FIRST_NAME = '{{ first_name | there }}';

// ---- The starters ----------------------------------------------------------------------------

export const STARTER_TEMPLATES: readonly StarterTemplateDef[] = [
  {
    key: 'personal-letter',
    name: 'Personal letter',
    description:
      'A short note in your own voice, one idea, no sections. The easiest issue to write and often the most replied to.',
    subject: 'Something I changed my mind about',
    preheader: 'A short one this week, and a question for you at the end.',
    content: doc(
      p(`Hi ${FIRST_NAME},`),
      p(
        'Open the way you would open an email to one friend. Say where you are writing from or what happened this week, in a sentence or two. The greeting above uses the reader’s first name when you have it and “there” when you don’t.',
      ),
      p(
        'Then get to the one thing this letter is about. A letter holds one idea well. If you have three, you have three letters, and that is good news for the next two weeks.',
      ),
      p(
        'Tell it as a story if you can: what you believed, what happened, what you think now. Specifics carry it. The name of the café, the number on the invoice, the exact thing someone said to you.',
      ),
      quote(
        p(
          'Pull out the one line you would want quoted back to you. A reader skimming on a phone will stop here.',
        ),
      ),
      p(
        'Close the thought in a short paragraph. You don’t need a lesson. “That’s where I’ve got to” is an honest ending.',
      ),
      p(
        b('A question for you: '),
        'end by asking one thing readers can answer in a line. Replies come straight to your inbox, and they tell mail services that people want your letters.',
      ),
      p('Until next week,'),
      p('Your name'),
      p(
        i(
          'P.S. A postscript is the second most read line of any letter. Use it for the one link or favour you care about.',
        ),
      ),
    ),
  },
  {
    key: 'weekly-roundup',
    name: 'Weekly roundup',
    description:
      'Curated links with a line of your own on each. Good for a regular slot when you read more than you write.',
    subject: 'Five things worth your time this week',
    preheader: 'One long read, three quick links and a tool I keep coming back to.',
    content: doc(
      p(
        'Two or three sentences to set the week up: what you were looking for, a thread that runs through the picks, or simply how many tabs you closed to get here.',
      ),
      h(2, 'The one to read if you read only one'),
      card(
        'Title of the best piece you found this week',
        'One sentence on what it argues and who wrote it.',
        'https://example.com/the-long-read',
      ),
      p(
        'Say why you picked it. The summary is on the other side of the link. Your reason for sending it is the part only you can write: what it changed for you, where you disagree, who should skip it.',
      ),
      h(2, 'Quick links'),
      ul(
        [
          a('A link with a clear title', 'https://example.com/one'),
          '. One line on why it is worth the click.',
        ],
        [
          a('A second link', 'https://example.com/two'),
          '. Keep each of these to a sentence. If it needs more, it belongs above.',
        ],
        [
          a('A third link', 'https://example.com/three'),
          '. Mix the sources. Three links from one site read like an advert.',
        ],
      ),
      h(2, 'A tool, a book or a number'),
      p(
        'A slot that changes every week keeps a roundup from feeling like a list. One thing you used, one page you underlined, or one figure that surprised you, with the source.',
      ),
      hr(),
      h(3, 'From the archive'),
      p(
        'Point new readers at one older issue: ',
        a('the title of a past post', 'https://example.com/archive'),
        '. A sentence on why it still holds up.',
      ),
      p(
        'Found something I should see? Reply with the link. The best finds in this letter come from readers.',
      ),
    ),
  },
  {
    key: 'essay',
    name: 'Long-form essay',
    description:
      'One argument, made properly, with sections a reader can find their place in. For the piece you want people to forward.',
    subject: 'The case for doing less, better',
    preheader: 'About a ten minute read. The argument is in the first paragraph.',
    content: doc(
      h(1, 'The title of the essay, as a claim'),
      p(
        i(
          'A one or two sentence standfirst: what the essay argues and why it matters now. Many readers decide here, so say the conclusion plainly.',
        ),
      ),
      p(
        'Start with a scene, a number or a question that puts the reader inside the problem. Leave the throat clearing out. The first paragraph should work as the whole essay in miniature for someone who stops after it.',
      ),
      p(
        'Then say what you are going to argue and how. Long pieces are easier to stay with when the reader knows the route.',
      ),
      h(2, 'First, the way things are usually done'),
      p(
        'Describe the common view fairly, in a way its holders would recognise. An essay that beats a weak version of the other side convinces nobody who held the strong one.',
      ),
      p(
        'Keep paragraphs short. In email, three or four sentences is a full paragraph. On a phone, more than that is a wall.',
      ),
      h(2, 'What that misses'),
      p(
        'Bring your evidence: what you saw, measured or lived through. Link to sources where a claim needs one, like ',
        a('this study', 'https://example.com/source'),
        ', and say in the sentence what the source shows so nobody has to click to follow you.',
      ),
      quote(p('Set the sentence the essay turns on apart, like this. One per essay is plenty.')),
      h(2, 'The objection you would raise yourself'),
      p(
        'Name the strongest reason you might be wrong and answer it. This is the section that earns a careful reader’s trust, and the one most writers cut.',
      ),
      h(2, 'So what should change'),
      p(
        'End on what follows if you are right: one thing to do, to stop doing, or to watch for. Return to the opening scene if it gives you a clean last line.',
      ),
      hr(),
      p(
        'If this was useful, forward it to one person who would argue with it. And reply if that person is you.',
      ),
    ),
  },
  {
    key: 'announcement',
    name: 'Announcement or launch',
    description:
      'One piece of news and one thing to do about it. For a launch, an event, a new section or a change readers need to know.',
    subject: 'It’s here: the name of the thing',
    preheader: 'What it is, who it is for and how to get it today.',
    content: doc(
      h(1, 'Say the news in one line'),
      p(
        'The first sentence says what is new and that it is available now (or on which date). Someone who reads nothing else should still know the news.',
      ),
      p(
        'The second paragraph says who it is for and what it lets them do that they could not do yesterday. Describe the reader’s Tuesday. Leave your roadmap for later.',
      ),
      button('See what’s new', 'https://example.com/launch'),
      h(2, 'What you get'),
      ul(
        [b('The first thing. '), 'What it does, in the reader’s words.'],
        [b('The second thing. '), 'Keep the three parallel: same length, same shape.'],
        [b('The third thing. '), 'Stop at three. A fourth is a sign one of them is not news.'],
      ),
      callout(
        p(
          b('The details people look for: '),
          'the date, the price, the place, the deadline. Put them in one box so nobody has to hunt.',
        ),
      ),
      h(2, 'Why we made it'),
      p(
        'Two or three sentences of story: the problem you kept running into, or the reader request that started it. This is what makes an announcement worth reading when you are not buying.',
      ),
      p(
        'Then repeat the one action. A reader who scrolled this far is the one most likely to take it.',
      ),
      button('Get it now', 'https://example.com/launch'),
      p('Questions? Reply to this email. It comes to a person.'),
    ),
  },
  {
    key: 'interview',
    name: 'Interview or Q&A',
    description:
      'A conversation with one guest, edited to questions and answers. Works for reader questions too.',
    subject: 'An interview with a guest worth hearing from',
    preheader: 'On how they work, what they would do differently and what they are reading.',
    content: doc(
      h(1, 'Guest name on the subject they know best'),
      p(
        'Introduce the guest in three sentences: who they are, the one thing they have done that makes them worth listening to on this subject, and how you came to talk to them.',
      ),
      p(
        i(
          'A line on the edit, such as: this conversation has been shortened and tidied for reading.',
        ),
      ),
      hr(),
      p(b('Start with an easy, concrete question: what does a normal working day look like?')),
      p(
        'The answer goes here in the guest’s own words. Trim the wind-up and keep the phrases that sound like them. Two short paragraphs read better than one long one.',
      ),
      p(b('Then the question your readers would ask if they were in the room.')),
      p(
        'Keep answers to what only this guest could say. If a line could come from anyone’s interview, it can go.',
      ),
      quote(p('Pull the most quotable sentence of the whole conversation out here.')),
      p(b('Ask about a mistake, or something they changed their mind about.')),
      p(
        'This is usually the best answer in the piece. Give it room, and resist tidying it into a moral.',
      ),
      p(b('What are you reading, watching or using that you would recommend?')),
      p(
        'A light question near the end gives readers something to take away. Link what they mention, like ',
        a('the book they named', 'https://example.com/book'),
        '.',
      ),
      p(b('Last one: where can people find your work?')),
      p(
        'Let the guest point somewhere. ',
        a('Their site or newsletter', 'https://example.com/guest'),
        ' is the thanks they get for their time.',
      ),
      hr(),
      p('Who should I talk to next? Reply with a name and the one question you would ask them.'),
    ),
  },
  {
    key: 'product-update',
    name: 'Product update or changelog',
    description:
      'What shipped, what was fixed and what is next, in a shape people can scan. For software, courses, shops and projects.',
    subject: 'What’s new this month',
    preheader: 'One big addition, four improvements and a fix you asked for.',
    content: doc(
      p(
        'One or two sentences on the month: the theme of the work, or the request you heard most. Skip “we’re excited”. Start with what changed for the reader.',
      ),
      h(2, 'New: the headline feature'),
      p(
        'What it does and what it replaces, in plain words. Then the smallest example that shows it working: “Type a date, and the reminder goes out that morning.”',
      ),
      button('Try it', 'https://example.com/whats-new'),
      h(2, 'Improved'),
      ul(
        [b('Faster search. '), 'Say the before and after if you measured it.'],
        [
          b('A clearer export. '),
          'One line each. Lead with the thing, not the team that built it.',
        ],
        [b('Better on phones. '), 'Name the screen, so people know where to look.'],
      ),
      h(2, 'Fixed'),
      ul(
        ['The bug most people reported, described the way they described it.'],
        ['A second fix. Thank the reader who found it, by first name if they agreed.'],
      ),
      columns(
        [
          h(3, 'Coming next'),
          p('One or two things in progress. Promise only what you would bet on.'),
        ],
        [
          h(3, 'Tell us'),
          p('What should be on this list next month? Reply and it reaches the people building it.'),
        ],
      ),
      hr(),
      p(
        'The full list of changes is in ',
        a('the changelog', 'https://example.com/changelog'),
        '.',
      ),
    ),
  },
  {
    key: 'paid-invitation',
    name: 'Invitation to go paid',
    description:
      'An issue that asks free readers to become paying ones: what they get, what it costs and why now.',
    subject: 'What paying subscribers get, and why I’m asking',
    preheader: 'The honest version: what it funds, what you get and what stays free.',
    content: doc(
      p(`Hi ${FIRST_NAME},`),
      p(
        'Start by saying plainly that this letter is an ask. Readers respect being told. One sentence on how long you have been writing this and what it has become.',
      ),
      p(
        'Then the reason. What does the work cost you in time or money, and what would paying readers let you do: more reporting, a second issue each week, no adverts. Use real numbers if you can share them.',
      ),
      h(2, 'What you get'),
      ul(
        [
          b('The thing only paying readers receive. '),
          'An extra issue, the full archive, the audio.',
        ],
        [b('A way to take part. '), 'Comments, a monthly call, a vote on what you cover next.'],
        [
          b('The work itself, kept going. '),
          'For many readers this is the reason. Say it without apology.',
        ],
      ),
      callout(
        p(
          b('The price, in one line: '),
          'for example, $6 a month or $60 a year, cancel any time. If there is an offer, give the date it ends.',
        ),
      ),
      button('Become a paying subscriber', 'https://example.com/subscribe'),
      h(2, 'What stays free'),
      p(
        'Tell free readers what they keep. Nobody should finish this letter worried they are about to lose something. If the weekly issue stays free, say so here.',
      ),
      quote(
        p(
          'A sentence from a paying reader on why they pay is worth more than a paragraph from you. Ask one for permission and put it here.',
        ),
      ),
      p(
        'Close warmly, and thank everyone who reads whether or not they pay. Then offer the button one more time.',
      ),
      button('See the plans', 'https://example.com/subscribe'),
      p(i('Can’t pay right now? Forwarding this letter to one friend helps just as much.')),
    ),
  },
  {
    key: 'welcome',
    name: 'Welcome issue',
    description:
      'The first email a new subscriber should read: who you are, what arrives when, and where to start.',
    subject: 'Welcome. Here’s what to expect',
    preheader: 'Who is writing to you, how often, and three posts to start with.',
    content: doc(
      p(`Hi ${FIRST_NAME},`),
      p(
        'Thank the reader for subscribing and say who you are in two sentences: your name, what you do, and why you write this. A new reader signed up minutes ago, so this is the best read email you will ever send.',
      ),
      h(2, 'What you’ll get'),
      ul(
        [
          b('What: '),
          'the kind of thing you send, such as one essay, five links or a short letter.',
        ],
        [b('When: '), 'the day and rough time, such as every Thursday morning. Then keep to it.'],
        [b('How long: '), 'a five minute read, or whatever is true. People like to know.'],
      ),
      h(2, 'Start here'),
      p('Three posts that show what this publication is at its best:'),
      card(
        'Your most shared post',
        'One line on what it is about.',
        'https://example.com/best-post',
      ),
      card(
        'The post that explains what you believe',
        'One line on why it matters to you.',
        'https://example.com/second-post',
      ),
      card(
        'A recent favourite',
        'One line that makes a reader curious.',
        'https://example.com/third-post',
      ),
      callout(
        p(
          b('One small favour: '),
          'reply to this email with a line about what brought you here. It tells your mail app these letters are wanted, and I read every reply.',
        ),
      ),
      p(
        'If these ever stop being useful, the unsubscribe link is at the bottom of every email. No hard feelings.',
      ),
      p('Glad you’re here,'),
      p('Your name'),
    ),
  },
];

const BY_KEY = new Map(STARTER_TEMPLATES.map((starter) => [starter.key as string, starter]));

/** The starter with this key, or null. */
export function starterTemplate(key: string): StarterTemplateDef | null {
  return BY_KEY.get(key) ?? null;
}

/** The starters without their documents, in the order the library shows them. */
export function starterTemplateSummaries(): StarterTemplateSummary[] {
  return STARTER_TEMPLATES.map(({ key, name, description, subject, preheader }) => ({
    key,
    name,
    description,
    subject,
    preheader,
  }));
}
