import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { ZodError } from 'zod'
import databasePlugin from './plugins/database.js'
import authPlugin from './plugins/auth.js'
import customerRoutes from './modules/customers/routes.js'
import authRoutes from './modules/auth/routes.js'
import oauthRoutes from './modules/auth/oauth.js'
import accountRoutes from './modules/accounts/routes.js'
import paymentRoutes from './modules/payments/routes.js'
import { AppError } from './shared/errors.js'
import   pixRoutes  from './modules/pix/routes.js'
import aspspRoutes from './modules/aspsp/routes.js'
import jsrRoutes from './modules/jsr/routes.js'

export async function buildApp() {
  const app = Fastify({ logger: true })

  // Some MCP/AI Gateway clients send a JSON body without the
  // `Content-Type: application/json` header (or with `text/plain`).
  // Fastify would otherwise reject those with 415. Accept any body by
  // attempting to parse it as JSON, falling back to the raw value.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body : String(body)
    if (!raw) {
      return done(null, {})
    }
    const contentType = _req.headers['content-type'] || ''
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(raw)
      const obj: Record<string, string> = {}
      for (const [key, value] of params.entries()) {
        obj[key] = value
      }
      return done(null, obj)
    }
    try {
      done(null, JSON.parse(raw))
    } catch {
      done(null, raw)
    }
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Banking API',
        description: 'Simplified banking backend API',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  await app.register(swaggerUi, { routePrefix: '/docs' })
  await app.register(databasePlugin)
  await app.register(authPlugin)

  app.get('/health', async (_request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`
      return { status: 'ok', database: 'reachable' }
    } catch (error) {
      app.log.error(error)
      return reply.code(503).send({ status: 'error', database: 'unreachable' })
    }
  })

  await app.register(customerRoutes)
  await app.register(authRoutes)
  await app.register(oauthRoutes)
  await app.register(accountRoutes)
  await app.register(paymentRoutes)
  await app.register(pixRoutes)
  await app.register(aspspRoutes)
  await app.register(jsrRoutes)

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: error.issues,
      })
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
      })
    }

    app.log.error(error)
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Unexpected server error',
    })
  })

  return app
}
