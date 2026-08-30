import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger, ProviderRegistry } from '@agent-dock/agent-runtime';
import { extractBearerToken, tokensMatch } from './auth-token.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSessionRoutes } from './routes/sessions.js';
import type { SessionManager } from './session-manager.js';

export interface BuildServerOptions {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  token: string;
  logger: Logger;
}

/**
 * Builds (but does not start) the daemon's HTTP server.
 *
 * Local-auth model (see SECURITY.md): every route except /health requires
 * `Authorization: Bearer <token>` with the token generated at process startup and handed to the
 * desktop client out-of-band (a local file, not the network). No CORS headers are ever added, so
 * a browser page cannot read cross-origin responses even if it guessed the token; and because
 * `Authorization` is a non-simple header, any cross-origin browser request triggers a CORS
 * preflight that this server never approves, so the request is never even sent to a route
 * handler. The Origin check below is an additional, explicit layer on top of that.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  const startedAt = Date.now();

  app.addHook('onRequest', async (req, reply) => {
    // AD-04: any Origin header at all is treated as browser-authored and rejected outright. A
    // non-browser client (curl, Electron main's own fetch, another local process) never sends
    // one. The previous version only recognized the literal `null` and `http(s)://` schemes, so a
    // `chrome-extension://` origin (or any other future scheme) fell straight through
    // unrecognized. There is no legitimate browser-originated caller of this API today: the
    // renderer talks to the daemon only through Electron main, never directly (see SECURITY.md),
    // so there's nothing to allowlist. An `AGENT_DOCK_ALLOWED_ORIGINS` escape hatch used to
    // exist for a hypothetical dev-server case, but nothing ever paired it with a real CORS
    // response header, so an allowlisted origin still couldn't complete a request; it was dead
    // configuration and has been removed rather than fixed, since nothing currently needs it.
    if (req.headers.origin !== undefined) {
      opts.logger.warn('rejected request carrying an Origin header', { origin: req.headers.origin, url: req.url });
      reply.code(403).send({ error: 'browser-originated requests are not allowed' });
      return reply;
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !tokensMatch(opts.token, provided)) {
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
  });

  registerHealthRoute(app, startedAt);
  registerProviderRoutes(app, opts.registry);
  registerSessionRoutes(app, opts.sessionManager, opts.registry);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Fastify's own body-parsing errors (malformed JSON, payload-too-large, ...) carry a real
    // 4xx statusCode already. Preserving it (rather than flattening everything to 500) keeps
    // client-error semantics correct without risking leaking anything: these messages describe
    // the malformed request, never internal state. Anything without a 4xx statusCode is treated
    // as unexpected and sanitized to a generic 500, same as before.
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;

    if (statusCode >= 500) {
      opts.logger.error('unhandled route error', { message: err.message, url: req.url });
      reply.code(500).send({ error: 'internal server error' });
      return;
    }
    opts.logger.warn('client error', { message: err.message, url: req.url, statusCode });
    reply.code(statusCode).send({ error: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not found' });
  });

  return app;
}
