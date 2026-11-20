import { createRoute } from '@hono/zod-openapi';
import {
  ErrorEnvelopeSchema,
  FlagsSchema,
  HealthSchema,
  dataEnvelope,
  idPattern,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { useRuntime } from '@swarm/runtime';
import { parseApiEnv } from './env';
import { createRouter, env } from './lib/context';
import { csrf, isSignedEndpoint } from './lib/csrf';
import { requireChannel } from './lib/access';
import { errors, idParam, ok } from './lib/openapi';
import { routePolicy } from './lib/policy';
import { loadSession, sessionToken } from './lib/session';
import { asks } from './routes/asks';
import { auth } from './routes/auth';
import { broadcasts } from './routes/broadcasts';
import { bulk } from './routes/bulk';
import { captureForms } from './routes/captureForms';
import { channels } from './routes/channels';
import { champions } from './routes/champions';
import { circles } from './routes/circles';
import { comp } from './routes/comp';
import { coupons } from './routes/coupons';
import { devmail } from './routes/devmail';
import { dispatches } from './routes/dispatches';
import { holdbacks } from './routes/holdbacks';
import { exports } from './routes/exports';
import { fields } from './routes/fields';
import { funnel } from './routes/funnel';
import { flows } from './routes/flows';
import { inboxRules } from './routes/inbox-rules';
import { gates } from './routes/gates';
import { google } from './routes/google';
import { imports } from './routes/imports';
import { instance } from './routes/instance';
import { journeys } from './routes/journeys';
import { levels } from './routes/levels';
import { goods } from './routes/goods';
import { linkHub } from './routes/linkHub';
import { partners } from './routes/partners';
import { sponsors } from './routes/sponsors';
import { media } from './routes/media';
import { members } from './routes/members';
import { memberViews } from './routes/memberViews';
import { overview } from './routes/overview';
import { revenue } from './routes/revenue';
import { payments } from './routes/payments';
import { paypal } from './routes/paypal';
import { archiveImport } from './routes/archiveImport';
import { messages } from './routes/messages';
import { snippets } from './routes/snippets';
import { sending } from './routes/sending';
import { series } from './routes/series';
import { rosters } from './routes/rosters';
import { site } from './routes/site';
import { siteDesign } from './routes/siteDesign';
import { authors } from './routes/authors';
import { tags } from './routes/tags';
import { templates } from './routes/templates';
import { webDomains } from './routes/webDomains';
import { workspaces } from './routes/workspaces';
import { retention } from './routes/retention';
import { apiKeys } from './routes/apiKeys';
import { deliverability } from './routes/deliverability';
import { suppressions } from './routes/suppressions';
import { bounces } from './routes/bounces';
import { exportDestinations } from './routes/exportDestinations';
import { directSends } from './routes/directSends';
import { oauth } from './routes/oauth';
import { oauthApps } from './routes/oauthApps';
import { privacy } from './routes/privacy';
import { pauseFeeds } from './routes/pauseFeeds';
import { security } from './routes/security';
import { sso } from './routes/sso';
import { webhooks } from './routes/webhooks';
import { applications } from './routes/applications';
import { emailChecks } from './routes/emailChecks';
import { copilot } from './routes/copilot';
import { copilotActions } from './routes/copilotActions';
import { appDirectory } from './routes/appDirectory';
import { recipeSubmissions } from './routes/recipeSubmissions';
import { mcp } from './routes/mcp';
import { operator } from './routes/operator';
import { feeds } from './routes/feeds';
import { authenticateV2 } from './v2/auth';
import { v2Docs } from './v2/docs';
import { idempotency } from './v2/idempotency';
import { registerInternalFetch } from './v2/internal';
import { v2Routers } from './v2/index';
import { rateLimitV2 } from './v2/ratelimit';

export function createApp() {
  const app = createRouter();

  useRuntime(app, { service: 'api', parseEnv: parseApiEnv, securityTxt: true });

  app.use('/api/*', csrf);
  app.use('/api/*', async (c, next) => {
    const auth = isSignedEndpoint(c.req.path) ? null : await loadSession(c);
    c.set('auth', auth);
    // The vault resolves the session itself: it is handed the cookie's value, never a claim.
    const token = auth ? sessionToken(c) : undefined;
    c.set('credential', token ? { kind: 'operator-session', sessionToken: token } : null);
    await next();
  });
  // Each operation's declared floor (lib/policy.ts), applied before its input is validated;
  // then Idempotency-Key on writes, per signed-in operator (as on /v2, per principal).
  app.use('/api/v1/*', routePolicy);
  app.use('/api/v1/*', idempotency);

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['Health'],
    summary: 'Liveness check',
    responses: { 200: ok(HealthSchema, 'The worker is up') },
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/flags',
      tags: ['Flags'],
      summary: 'Feature flags in effect',
      responses: {
        200: ok(FlagsSchema, 'Flag values'),
        503: {
          description: 'Not configured',
          content: { 'application/json': { schema: ErrorEnvelopeSchema } },
        },
      },
    }),
    async (c) => {
      const e = env(c);
      const flags = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).all();
      return c.json(dataEnvelope(FlagsSchema).parse({ data: { flags } }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/channels/{channelId}/flags',
      tags: ['Flags'],
      summary: 'Feature flags in effect for one Channel',
      description:
        'Every registered flag, resolved platform → workspace → Channel, so the dashboard can hide an optional feature before the server refuses it.',
      request: { params: idParam('channelId', idPattern('channel')) },
      responses: { 200: ok(FlagsSchema, 'Flag values'), ...errors('unauthorized', 'not_found') },
    }),
    async (c) => {
      const { channelId } = c.req.valid('param');
      const access = await requireChannel(c, channelId, 'viewer');
      const e = env(c);
      const flags = await new FlagService(new D1FlagStore(e.DB, e.CACHE)).all({
        workspaceId: access.workspaceId,
        channelId,
      });
      return c.json(dataEnvelope(FlagsSchema).parse({ data: { flags } }), 200);
    },
  );

  app.route('/', auth);
  app.route('/', google);
  app.route('/', instance);
  app.route('/', workspaces);
  app.route('/', retention);
  app.route('/', channels);
  app.route('/', media);
  app.route('/', members);
  app.route('/', memberViews);
  app.route('/', dispatches);
  app.route('/', holdbacks);
  app.route('/', broadcasts);
  app.route('/', overview);
  app.route('/', sending);
  app.route('/', messages);
  app.route('/', archiveImport);
  app.route('/', snippets);
  app.route('/', fields);
  app.route('/', tags);
  app.route('/', imports);
  app.route('/', exports);
  app.route('/', bulk);
  app.route('/', captureForms);
  app.route('/', circles);
  app.route('/', site);
  app.route('/', siteDesign);
  app.route('/', authors);
  app.route('/', webDomains);
  app.route('/', levels);
  app.route('/', coupons);
  app.route('/', comp);
  app.route('/', gates);
  app.route('/', revenue);
  app.route('/', funnel);
  app.route('/', payments);
  app.route('/', paypal);
  app.route('/', flows);
  app.route('/', inboxRules);
  app.route('/', templates);
  app.route('/', champions);
  app.route('/', series);
  app.route('/', asks);
  app.route('/', journeys);
  app.route('/', devmail);
  // Phase 7 (dashboard side)
  app.route('/', apiKeys);
  app.route('/', oauthApps);
  app.route('/', oauth);
  app.route('/', directSends);
  app.route('/', webhooks);
  app.route('/', privacy);
  app.route('/', exportDestinations);
  app.route('/', security);
  app.route('/', pauseFeeds);
  app.route('/', sso);
  app.route('/', deliverability);
  // Phase 8
  app.route('/', applications);
  app.route('/', emailChecks);
  app.route('/', copilot);
  app.route('/', copilotActions);
  app.route('/', linkHub);
  app.route('/', goods);
  app.route('/', partners);
  app.route('/', sponsors);
  app.route('/', appDirectory);
  app.route('/', recipeSubmissions);
  app.route('/', rosters);
  app.route('/', feeds);
  app.route('/', suppressions);
  app.route('/', bounces);

  // The public API: Bearer keys or OAuth tokens, never the session cookie, so no CSRF check.
  app.use('/v2/*', authenticateV2);
  app.use('/v2/*', rateLimitV2);
  // Idempotency-Key on /v2 runs inside each route, after its scope and Channel check (route.ts).
  for (const router of v2Routers) app.route('/', router);
  // Its documents (public): /v2/openapi.json, /v2/reference, /.well-known/api-catalog.
  app.route('/', v2Docs);
  // Open Operator (Phase 8): the MCP server over /v2 and its dashboard routes.
  app.route('/', operator);
  app.route('/', mcp);
  registerInternalFetch((request, env, ctx) => app.fetch(request, env, ctx));

  return app;
}

export function openApiDocument(app: ReturnType<typeof createApp>) {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Swarm API',
      version: '0.3.0',
      description:
        'Dashboard API (cookie session). Writes require the dashboard Origin and a JSON or multipart body. The public API (/v2) arrives in Phase 7.',
    },
  });
}
