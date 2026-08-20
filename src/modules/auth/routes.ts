import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { AppError } from '../../shared/errors.js'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/auth/login', async (request) => {
    const input = loginSchema.parse(request.body)

    const user = await app.prisma.user.findUnique({
      where: { username: input.username },
      include: { customer: true },
    })

    if (!user?.customer || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new AppError(401, 'Invalid username or password', 'INVALID_CREDENTIALS')
    }

    const accessToken = app.jwt.sign(
      {
        sub: user.id,
        customerId: user.customer.id,
        username: user.username,
      },
      { expiresIn: '1h' },
    )

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 3600,
    }
  })
}

export default authRoutes
