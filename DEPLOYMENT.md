# Deployment: Render + AWS RDS PostgreSQL + Sensedia API Gateway

## Target architecture

```text
Consumers
   |
   v
Sensedia API Gateway
   |
   | HTTPS
   v
Render Web Service (Node.js / Fastify)
   |
   | PostgreSQL over TLS
   v
AWS RDS for PostgreSQL
```

## 1. AWS RDS PostgreSQL

Create an RDS PostgreSQL instance/database, for example:

- Database: `banking`
- Port: `5432`
- Application user: `banking_user`
- SSL/TLS: required

Because the application runs on Render, the RDS instance must be reachable from outside the AWS VPC unless you introduce a private-network connectivity layer between Render and AWS. For a simple MVP, this normally means a publicly reachable RDS endpoint protected by a restrictive Security Group and TLS.

Do **not** expose port 5432 to `0.0.0.0/0` in a real environment. Restrict inbound access to trusted Render outbound addresses/network ranges available for your service/plan.

Example Render secret:

```text
DATABASE_URL=postgresql://banking_user:<PASSWORD>@<RDS_ENDPOINT>:5432/banking?schema=public&sslmode=require
```

For stricter certificate validation, use AWS's RDS CA certificate and `sslmode=verify-full` where supported by your connection setup.

## 2. Render

Connect the repository containing this project and create a Web Service, or use `render.yaml` as a Blueprint.

Configuration:

```text
Build Command:
npm ci && npm run prisma:generate && npm run build

Start Command:
npm run db:deploy && npm run start:prod

Health Check Path:
/health
```

Environment variables/secrets:

```text
DATABASE_URL=<AWS RDS connection string>
JWT_SECRET=<long random secret>
NODE_ENV=production
```

Do not hardcode secrets in the repository.

Render supplies the service `PORT`; `server.ts` already reads it automatically and binds to `0.0.0.0`.

The `/health` endpoint performs a lightweight `SELECT 1`, so Render only marks the application healthy when the application can also reach PostgreSQL.

## 3. Database migrations

The production start command runs:

```bash
npm run db:deploy
```

which executes:

```bash
prisma migrate deploy
```

This applies committed Prisma migrations without using development migration commands in production.

## 4. Sensedia API Gateway

After Render deploys the service, use the Render HTTPS URL as the backend target for the Sensedia API, for example:

```text
https://<service>.onrender.com
```

Expose the public banking paths only through Sensedia, for example:

```text
POST /v1/customers
POST /v1/auth/login
POST /v1/accounts
GET  /v1/accounts/{accountId}
GET  /v1/accounts/{accountId}/balance
GET  /v1/accounts/{accountId}/transactions
POST /v1/accounts/{accountId}/credits
POST /v1/accounts/{accountId}/payments
GET  /v1/payments/{paymentId}
```

Recommended Gateway responsibilities:

- TLS termination for consumers.
- Rate limiting / spike protection.
- IP filtering where applicable.
- Correlation/request ID.
- Request/response logging with masking of credentials and sensitive data.
- Threat protection / request validation.
- CORS only if a browser client requires it.
- Preserve and forward `Authorization` and `Idempotency-Key` headers.

### Authentication boundary

For the current MVP, Sensedia proxies the request and the Node.js application validates its own JWT.

```text
Consumer
  | Authorization: Bearer <JWT>
  v
Sensedia Gateway
  | forwards Authorization
  v
Node.js
  | validates JWT + account ownership
```

Later, authentication can be centralized or federated at the gateway/OAuth layer, but keeping application authorization checks is still important.

## 5. Restrict direct Render access

The Render service has a public HTTPS endpoint, so simply placing Sensedia in front of it does not automatically make Sensedia the *only* network path.

For an MVP, add a gateway-to-backend shared secret/header that Sensedia injects and the Node.js application validates, or restrict backend ingress by source IP if your Sensedia/Render networking setup offers stable ranges.

A stronger production architecture should avoid relying only on obscurity of the Render URL.

## 6. Suggested environments

Use separate resources/configurations:

```text
DEV
Sensedia DEV -> Render DEV -> RDS DEV

HML
Sensedia HML -> Render HML -> RDS HML

PROD
Sensedia PROD -> Render PROD -> RDS PROD
```

Never share the same database or JWT secret across environments.
