import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../shared/errors.js'
import { publicBaseUrl } from '../../shared/public-url.js'
import { ASSET_PATHS, metaRefreshTag, returnLinkHtml } from '../assets/routes.js'

const authorizeSchema = z.object({
  redirect_uri: z.string().url(),
})

const confirmSchema = z.object({
  request_id: z.string().uuid(),
  username: z.string().min(1),
  password: z.string().min(1),
})

const tokenSchema = z.object({
  code: z.string().min(1),
})

/**
 * Estilo e logo vem de arquivo, e nao inline: atras do gateway a CSP traz
 * `style-src 'self'` e `img-src 'self'`, que recusam <style> inline e data:
 * URI. A tela aparecia crua e sem logo.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function loginPageHtml(baseUrl: string, requestId: string, error?: string): string {
  const errorBlock = error
    ? `<div class="error">${error}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login — Sensedia</title>
  <link rel="stylesheet" href="${escapeAttr(baseUrl)}${ASSET_PATHS.css}" />
</head>
<body>
  <div class="card login">
    <img class="logo" src="${escapeAttr(baseUrl)}${ASSET_PATHS.logo}" alt="Sensedia" />
    <div class="eyebrow">Acesso seguro</div>
    <h1>Entrar na sua conta</h1>
    <p class="subtitle">Autentique-se para continuar</p>
    ${errorBlock}
    <form method="POST" action="/v1/auth/login/confirm">
      <input type="hidden" name="request_id" value="${requestId}" />
      <label for="username">Usuário</label>
      <input type="text" id="username" name="username" autocomplete="username" required />
      <label for="password">Senha</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Entrar</button>
    </form>
    <div class="footer">Sensedia · API Platform</div>
  </div>
</body>
</html>`
}

/**
 * Tela de volta a Iniciadora depois do login.
 *
 * Responder 302 aqui nao funciona atras da CSP do gateway: `form-action 'self'`
 * alcanca tambem o redirect que segue o POST do formulario, e o destino e outra
 * origem. O meta refresh nao cai nessa diretiva.
 */
function returningPageHtml(baseUrl: string, returnUrl: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Autenticado</title>
  <link rel="stylesheet" href="${escapeAttr(baseUrl)}${ASSET_PATHS.css}" />${metaRefreshTag(returnUrl)}
</head>
<body>
  <div class="card login">
    <img class="logo" src="${escapeAttr(baseUrl)}${ASSET_PATHS.logo}" alt="Sensedia" />
    <div class="eyebrow">Acesso seguro</div>
    <h1>Tudo certo</h1>
    <p class="subtitle">Voltando para onde você começou...</p>
${returnLinkHtml(returnUrl, 'Continuar agora')}
    <div class="footer">Sensedia · API Platform</div>
  </div>
</body>
</html>`
}

const oauthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/auth/authorize', async (request) => {
    const input = authorizeSchema.parse(request.body)

    const authRequest = await app.prisma.authRequest.create({
      data: { redirectUri: input.redirect_uri },
    })

    return {
      request_id: authRequest.id,
      login_url: `/v1/auth/login?request_id=${authRequest.id}`,
    }
  })

  app.get('/v1/auth/login', async (request, reply) => {
    const { request_id } = z.object({ request_id: z.string().uuid() }).parse(request.query)

    const authRequest = await app.prisma.authRequest.findUnique({ where: { id: request_id } })
    if (!authRequest) {
      throw new AppError(404, 'Login request not found', 'AUTH_REQUEST_NOT_FOUND')
    }

    return reply.type('text/html').send(loginPageHtml(publicBaseUrl(request), request_id))
  })

  app.post('/v1/auth/login/confirm', async (request, reply) => {
    const input = confirmSchema.parse(request.body)

    const authRequest = await app.prisma.authRequest.findUnique({ where: { id: input.request_id } })
    if (!authRequest) {
      throw new AppError(404, 'Login request not found', 'AUTH_REQUEST_NOT_FOUND')
    }
    if (authRequest.code) {
      throw new AppError(409, 'Login request already completed', 'AUTH_REQUEST_COMPLETED')
    }

    const user = await app.prisma.user.findUnique({
      where: { username: input.username },
      include: { customer: true },
    })

    if (!user?.customer || !(await bcrypt.compare(input.password, user.passwordHash))) {
      return reply
        .type('text/html')
        .send(loginPageHtml(publicBaseUrl(request), input.request_id, 'Usuário ou senha inválidos.'))
    }

    const code = randomUUID()
    await app.prisma.authRequest.update({
      where: { id: authRequest.id },
      data: { code, userId: user.id },
    })

    const separator = authRequest.redirectUri.includes('?') ? '&' : '?'
    const back = `${authRequest.redirectUri}${separator}code=${code}&state=${authRequest.id}`
    return reply.type('text/html').send(returningPageHtml(publicBaseUrl(request), back))
  })

  app.post('/v1/auth/token', async (request) => {
    const input = tokenSchema.parse(request.body)

    const authRequest = await app.prisma.authRequest.findUnique({ where: { code: input.code } })
    if (!authRequest) {
      throw new AppError(400, 'Invalid authorization code', 'INVALID_AUTH_CODE')
    }
    if (authRequest.used) {
      throw new AppError(400, 'Authorization code already used', 'AUTH_CODE_USED')
    }
    if (!authRequest.userId) {
      throw new AppError(400, 'Authorization code has no associated user', 'INVALID_AUTH_CODE')
    }

    const user = await app.prisma.user.findUnique({
      where: { id: authRequest.userId },
      include: { customer: true },
    })
    if (!user?.customer) {
      throw new AppError(401, 'User not found', 'USER_NOT_FOUND')
    }

    await app.prisma.authRequest.update({
      where: { id: authRequest.id },
      data: { used: true },
    })

    const accessToken = app.jwt.sign(
      {
        sub: user.id,
        customerId: user.customer.id,
        username: user.username,
      },
      { expiresIn: '1h' },
    )

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    }
  })
}

export default oauthRoutes
