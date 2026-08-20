import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { AppError } from '../../shared/errors.js'

const createCustomerSchema = z.object({
  name: z.string().min(3).max(120),
  document: z.string().min(11).max(14).regex(/^\d+$/, 'document must contain only digits'),
  email: z.email(),
  username: z.string().min(4).max(50),
  password: z.string().min(8).max(100),
})

const customerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/customers', async (request, reply) => {
    const input = createCustomerSchema.parse(request.body)
    const passwordHash = await bcrypt.hash(input.password, 12)

    try {
      const customer = await app.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username: input.username,
            passwordHash,
          },
        })

        return tx.customer.create({
          data: {
            userId: user.id,
            name: input.name,
            document: input.document,
            email: input.email,
          },
        })
      })

      return reply.code(201).send({
        id: customer.id,
        name: customer.name,
        document: customer.document,
        email: customer.email,
        createdAt: customer.createdAt,
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'Username, document or email already registered', 'DUPLICATE_CUSTOMER')
      }
      throw error
    }
  })
}

export default customerRoutes
