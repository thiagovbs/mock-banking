import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../shared/errors.js'

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

function loginPageHtml(requestId: string, error?: string): string {
  const errorBlock = error
    ? `<div class="error">${error}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login — Sensedia</title>
  <style>
    :root {
      --bg:#FBFAFC; --surface:#FFFFFF; --surface-2:#F4F2F8; --ink:#1A1526;
      --muted:#6B6280; --faint:#8E85A3; --line:#E7E2F0;
      --purple:#8241B0; --purple-soft:#F0E7F8; --orange:#EA5B0C; --orange-soft:#FCEBDF;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(26,21,38,0.08);
      width: 100%;
      max-width: 400px;
      padding: 40px 32px;
    }
    .logo {
      display: block;
      margin: 0 auto 28px;
      height: 40px;
      width: auto;
    }
    .eyebrow {
      font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-size: 11px;
      color: var(--orange);
      text-align: center;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 8px;
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
      text-align: center;
      margin-bottom: 28px;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      font-size: 15px;
      color: var(--ink);
      background: var(--surface);
      margin-bottom: 18px;
      transition: border-color .15s, box-shadow .15s;
    }
    input:focus {
      outline: none;
      border-color: var(--purple);
      box-shadow: 0 0 0 3px var(--purple-soft);
    }
    button {
      width: 100%;
      padding: 13px;
      background: var(--orange);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: #C2480A; }
    .error {
      background: var(--orange-soft);
      color: #C2480A;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 18px;
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--faint);
    }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MTIiIGhlaWdodD0iMjI2IiB2aWV3Qm94PSIwIDAgODEyIDIyNiI+PHJlY3Qgd2lkdGg9IjgxMiIgaGVpZ2h0PSIyMjYiIGZpbGw9IiNmZmZmZmYiLz48dGV4dCB4PSI0MDYiIHk9IjEzMCIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjYwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjODI0MUIwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5TZW5zZWRpYTwvdGV4dD48L3N2Zz4=" alt="Sensedia" />
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

    return reply.type('text/html').send(loginPageHtml(request_id))
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
      return reply.type('text/html').send(loginPageHtml(input.request_id, 'Usuário ou senha inválidos.'))
    }

    const code = randomUUID()
    await app.prisma.authRequest.update({
      where: { id: authRequest.id },
      data: { code, userId: user.id },
    })

    const separator = authRequest.redirectUri.includes('?') ? '&' : '?'
    return reply.redirect(`${authRequest.redirectUri}${separator}code=${code}&state=${authRequest.id}`)
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
