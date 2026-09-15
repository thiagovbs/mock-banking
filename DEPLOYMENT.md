# Deployment: Docker + AWS RDS MySQL + Sensedia API Gateway

## Target architecture

```text
Consumers
   |
   v
Sensedia API Gateway
   |
   | HTTPS
   v
Docker host -> banking-api container (Node.js / Fastify)
   |
   | MySQL over TLS
   v
AWS RDS for MySQL
```

## 1. AWS RDS MySQL

The Prisma datasource is `mysql` (`prisma/schema.prisma`), so the database must be MySQL:

- Database: `Banking`
- Port: `3306`
- Application user: a dedicated user, not the instance master user
- SSL/TLS: required

Because the container runs outside the AWS VPC, the RDS instance must be reachable from the Docker host unless you introduce a private-network connectivity layer. For a simple MVP this usually means a publicly reachable RDS endpoint protected by a restrictive Security Group and TLS.

Do **not** expose port 3306 to `0.0.0.0/0`. Restrict inbound access to the Docker host's outbound IP.

Connection string:

```text
DATABASE_URL=mysql://banking_user:<PASSWORD>@<RDS_ENDPOINT>:3306/Banking
```

For stricter certificate validation, append `?sslaccept=strict` and supply the AWS RDS CA. Note that `sslmode` is a PostgreSQL parameter and has no effect on the MySQL connector.

## 2. Container build and run

The `Dockerfile` is multi-stage: the builder installs dependencies, runs `prisma generate` and compiles TypeScript; the runtime image carries only `node_modules`, `dist` and `prisma`.

```bash
docker compose up -d --build
```

The container listens on `3000` and `docker-compose.yml` publishes it on **`3100`** of the host (`3100:3000`). The application reads `PORT` and `HOST` from the environment and binds to `0.0.0.0` by default.

`docker-compose.yml` loads `.env` through `env_file`, but also declares `DATABASE_URL: "${DATABASE_URL}"`. That explicit key **overrides** the value coming from `env_file`, so if the variable is not exported in the host shell the container starts with an empty connection string. Either export it before bringing the stack up, or remove the `environment` block and rely on `env_file` alone:

```bash
export DATABASE_URL='mysql://banking_user:<PASSWORD>@<RDS_ENDPOINT>:3306/Banking'
```

Single quotes matter when the password contains `$`.

## 3. Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | MySQL connection string |
| `JWT_SECRET` | yes | Signs user JWTs. A long random value |
| `INITIATOR_SERVICE_SECRET` | yes | Shared secret with the Iniciadora, validated on the `x-initiator-key` header of the JSR routes |
| `PORT` | no | HTTP port (default `3000`) |
| `HOST` | no | Bind address (default `0.0.0.0`) |

`JWT_SECRET` and `INITIATOR_SERVICE_SECRET` are validated at boot: if either is missing or empty the application refuses to start and logs which one is absent. This is deliberate — an unset `JWT_SECRET` previously fell back to a default value present in the source code.

Never commit real values. `.env` is git-ignored; `.env.example` is a template with empty values.

## 4. Database migrations

The container start command runs:

```bash
npm run db:deploy
```

which executes:

```bash
prisma migrate deploy
```

This applies committed Prisma migrations without using development migration commands in production.

## 5. Health check

`GET /health` performs a lightweight `SELECT 1`, so the service is only reported healthy when it can also reach MySQL. `docker-compose.yml` already wires this into a container healthcheck.

## 6. Sensedia API Gateway

Point the Sensedia API destination at the published backend address, for example:

```text
http://<docker-host>:3100
```

Expose only the paths consumers actually need. The routes below are the ones the application implements:

```text
Public
POST   /v1/customers
POST   /v1/auth/login
POST   /v1/auth/authorize
GET    /v1/auth/login
POST   /v1/auth/login/confirm
POST   /v1/auth/token

Bearer JWT
GET    /v1/me/accounts
POST   /v1/accounts
GET    /v1/accounts/{accountId}
GET    /v1/accounts/{accountId}/balance
GET    /v1/accounts/{accountId}/transactions
GET    /v1/accounts/{accountId}/pix/keys
POST   /v1/accounts/{accountId}/pix/keys
POST   /v1/accounts/{accountId}/pix/transfers
GET    /v1/pix/transfers/{pixTransferId}
POST   /v1/me/payments
GET    /v1/payments/{paymentId}
POST   /v1/me/qrcodes
GET    /v1/me/qrcodes/{id}
DELETE /v1/me/qrcodes/{id}
POST   /v1/qrcodes/{id}/pay
POST   /v1/aspsp/payments/consents
POST   /v1/aspsp/payments
GET    /v1/aspsp/payments/{consentId}

x-initiator-key (JSR)
POST   /open-banking/itp/v2/enrollments
GET    /open-banking/itp/v2/enrollments/{enrollmentId}
GET    /open-banking/itp/v2/accounts/{accountNumber}/enrollments
PATCH  /open-banking/enrollment-supports/v2/enrollment-supports/{enrollmentId}/account-holder-confirmed
POST   /open-banking/itp/v2/enrollments/confirmations
POST   /open-banking/itp/v2/enrollments/{enrollmentId}/fido-registration
POST   /open-banking/pisp/payments/v5/jsr/consents
POST   /open-banking/itp/v2/consents/{consentId}/authorise
POST   /open-banking/pisp/payments/v5/jsr/pix/payments
GET    /open-banking/pisp/payments/v5/jsr/pix/payments/{paymentId}
```

There is no credit endpoint: every balance increase happens through a received PIX transfer.

Recommended Gateway responsibilities:

- TLS termination for consumers.
- Rate limiting / spike protection.
- IP filtering where applicable.
- Correlation/request ID.
- Request/response logging with masking of credentials and sensitive data.
- Threat protection / request validation.
- CORS only if a browser client requires it.
- Preserve and forward `Authorization` and `x-initiator-key` headers.

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

## 7. Restrict direct backend access

Publishing the container on a host port makes it reachable by anyone who can route to that address, so placing Sensedia in front of it does not by itself make the gateway the *only* network path. Anyone calling `http://<docker-host>:3100` directly bypasses gateway policies, quotas and interceptors.

Two things to address:

- **Network**: restrict ingress on the published port to the gateway's source addresses, or bind the container to a private interface and reach it over a private link.
- **Transport**: traffic between the gateway and the backend is plain HTTP on this port. JWTs and login payloads travel unencrypted; terminate TLS in front of the container or use a private, encrypted path.

A gateway-to-backend shared secret header is a useful additional layer, but it does not replace either of the items above.

## 8. Suggested environments

Use separate resources/configurations:

```text
DEV
Sensedia DEV -> banking-api DEV -> RDS DEV

HML
Sensedia HML -> banking-api HML -> RDS HML

PROD
Sensedia PROD -> banking-api PROD -> RDS PROD
```

Never share the same database, `JWT_SECRET` or `INITIATOR_SERVICE_SECRET` across environments.
