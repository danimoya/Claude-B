import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthManager } from '../auth.js';

interface TokenRequest {
  api_key: string;
}

interface RefreshRequest {
  refresh_token: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  authManager: AuthManager
): Promise<void> {
  // Credentials are bootstrapped from the owner's api.key file / local IPC.
  // Loopback alone is insufficient: other local users and forwarded requests
  // must not be able to retrieve or rotate the daemon's credentials.
  const authorizeCredentialAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    const isLocalhost = request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
    if (!isLocalhost) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Credential access requires localhost' });
    }
    if (authManager.validateApiKey(request.headers['x-claude-b-key'])) return;
    try {
      await request.jwtVerify();
      if (authManager.validateTokenPayload(request.user, 'access')) return;
    } catch {
      // Return the same response for missing and invalid credentials.
    }
    return reply.status(401).send({ error: 'Unauthorized', message: 'Current API key or access token required' });
  };

  // Get token using API key
  app.post<{ Body: TokenRequest }>('/api/auth/token', {
    schema: {
      body: {
        type: 'object',
        required: ['api_key'],
        properties: {
          api_key: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: TokenRequest }>, reply: FastifyReply) => {
    const { api_key } = request.body;

    if (!authManager.validateApiKey(api_key)) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key'
      });
    }

    const accessPayload = authManager.createAccessTokenPayload();
    const refreshPayload = authManager.createRefreshTokenPayload();

    const accessToken = app.jwt.sign(accessPayload, { expiresIn: '1h' });
    const refreshToken = app.jwt.sign(refreshPayload, { expiresIn: '7d' });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600
    };
  });

  // Refresh access token using refresh token
  app.post<{ Body: RefreshRequest }>('/api/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        properties: {
          refresh_token: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: RefreshRequest }>, reply: FastifyReply) => {
    const { refresh_token } = request.body;

    try {
      const decoded = app.jwt.verify(refresh_token);

      if (!authManager.validateTokenPayload(decoded, 'refresh')) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token'
        });
      }

      const accessPayload = authManager.createAccessTokenPayload();
      const accessToken = app.jwt.sign(accessPayload, { expiresIn: '1h' });

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600
      };
    } catch {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid refresh token'
      });
    }
  });

  // Verify current token
  app.get('/api/auth/verify', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest, _reply: FastifyReply) => {
    return {
      valid: true,
      user: request.user
    };
  });

  app.get('/api/auth/key', { preHandler: authorizeCredentialAccess }, async () => {
    const apiKey = await authManager.ensureApiKey();
    return { api_key: apiKey };
  });

  app.post('/api/auth/key/regenerate', { preHandler: authorizeCredentialAccess }, async () => {
    const apiKey = await authManager.generateApiKey();
    return {
      api_key: apiKey,
      message: 'API key regenerated. All existing tokens are now invalid.'
    };
  });
}
