# Banking API (Core Bancário)

Backend bancário simplificado construído com Node.js, TypeScript, Fastify, Prisma e **MySQL** (AWS RDS). Serve como **detentora de conta (ASPSP)** em uma demo de Open Finance: cadastro de titulares, contas, chaves PIX, transferências PIX, consentimentos e a **jornada JSR** (vinculação de dispositivo via FIDO2 + pagamento sem redirect).

> ⚠️ **Nota sobre o banco de dados:** este projeto usa **MySQL** (`datasource db { provider = "mysql" }`), não PostgreSQL. Em desenvolvimento local, o `.env` aponta para um **Amazon RDS**. O `docker-compose.yml` empacota a aplicação (publicada na porta `3100`), mas **não provisiona o banco** — o MySQL deve ser externo.

## Funcionalidades

- Cadastro de titular (nome, documento, e-mail) + usuário/senha
- Login com JWT (`/v1/auth/login`)
- Criação e consulta de conta corrente
- Consulta de saldo e extrato (ledger de movimentações)
- Gestão de **chaves PIX** (CPF, CNPJ, EMAIL, PHONE, EVP)
- **Transferência PIX** entre contas internas (única origem de crédito)
- Fachada de pagamentos (`/v1/me/payments`) com PIX, QR_CODE, BOLETO e BILL
- Fluxo OAuth simplificado (autorize → login → token)
- **Jornada JSR (Open Finance)**: ITP enrollment, registro FIDO, consentimento e pagamento sem redirect
- Controle de concorrência com `SELECT ... FOR UPDATE`
- Idempotência de PIX por `consentId` e `endToEndId`
- Swagger UI

> **Importante:** **não existe rota pública de crédito** (a antiga `POST /v1/accounts/:accountId/credits` foi removida). Toda entrada de saldo ocorre por **recebimento de PIX** (transferência de outra conta interna). Em um ambiente bancário real, crédito em conta deve ser originado por um fluxo autorizado e segregado.

## Stack

- Node.js 22+
- TypeScript
- Fastify 5
- Prisma 6 (ORM)
- MySQL (AWS RDS)
- JWT (`@fastify/jwt`)
- Zod (validação)
- Vitest (testes)

## Requisitos

- Node.js 22+
- npm
- Acesso a uma instância MySQL (RDS ou local)

## Configuração do ambiente

Copie o `.env.example` para `.env` e ajuste os valores:

```bash
cp .env.example .env
```

Variáveis principais:

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string MySQL (ex.: `mysql://user:senha@host:3306/Banking`) |
| `JWT_SECRET` | Segredo para assinatura dos JWTs |
| `INITIATOR_SERVICE_SECRET` | Segredo compartilhado com a Iniciadora (header `x-initiator-key`) usado nas rotas ITP/PISP JSR |
| `PORT` | Porta HTTP (padrão `3000`) |
| `HOST` | Host de bind (padrão `0.0.0.0`) |

## Preparar banco e Prisma Client

```bash
npm install
npm run prisma:generate   # gera o Prisma Client
npm run db:deploy         # aplica migrations no banco
```

## Iniciar a API

Desenvolvimento (hot reload):

```bash
npm run dev
```

Produção/build:

```bash
npm run build
npm run start:prod
```

A API sobe em `http://localhost:3000` (ou `PORT`).

- Swagger UI: `http://localhost:3000/docs`
- Health check: `http://localhost:3000/health`

## Autenticação

### Usuário (rotas `/v1/*`)

As rotas protegidas exigem um **JWT Bearer**. Envie no header:

```
Authorization: Bearer <accessToken>
```

O token é obtido em `POST /v1/auth/login`. O backend também aceita o header alternativo `x-Authorization` com o mesmo token.

### Iniciadora (rotas `/open-banking/*` JSR)

As rotas ITP/PISP JSR são chamadas pela **Iniciadora** (aplicação de serviço), não por um usuário logado. Elas exigem o header:

```
x-initiator-key: <INITIATOR_SERVICE_SECRET>
```

O valor deve coincidir com `INITIATOR_SERVICE_SECRET` do ambiente.

## Fluxo de teste básico

### 1. Cadastrar titular

```bash
curl -X POST http://localhost:3000/v1/customers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Joao da Silva",
    "document": "12345678901",
    "email": "joao@example.com",
    "username": "joao.silva",
    "password": "Senha@123"
  }'
```

### 2. Login

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{ "username": "joao.silva", "password": "Senha@123" }'
```

Copie o `accessToken` retornado:

```bash
export TOKEN='SEU_TOKEN'
export AH="Authorization: Bearer $TOKEN"
```

### 3. Listar / criar conta

```bash
# Listar contas do usuário autenticado
curl http://localhost:3000/v1/me/accounts -H "$AH"

# Criar uma nova conta
curl -X POST http://localhost:3000/v1/accounts -H "$AH"
```

Copie o `id` da conta:

```bash
export ACCOUNT_ID='UUID_DA_CONTA'
```

### 4. Cadastrar chave PIX na conta

```bash
curl -X POST http://localhost:3000/v1/accounts/$ACCOUNT_ID/pix/keys \
  -H "$AH" -H 'Content-Type: application/json' \
  -d '{ "type": "EMAIL", "value": "joao@email.com" }'

# Ou gerar uma EVP automaticamente:
curl -X POST http://localhost:3000/v1/accounts/$ACCOUNT_ID/pix/keys -H "$AH"
```

### 5. Receber saldo via PIX

Como não há crédito direto, o saldo entra por **transferência PIX** vinda de outra conta interna (origem e destino diferentes). Com uma segunda conta/chave PIX ativa, transfira para a conta alvo:

```bash
curl -X POST http://localhost:3000/v1/accounts/$SOURCE_ACCOUNT_ID/pix/transfers \
  -H "$AH" -H 'Content-Type: application/json' \
  -d '{
    "amount": "1000.00",
    "pixKey": { "type": "EMAIL", "value": "joao@email.com" },
    "consentId": "consent-teste-001",
    "description": "Carga inicial para teste"
  }'
```

> O `consentId` é obrigatório e único; repetir o mesmo `consentId` resulta em replay idempotente (sem novo débito).

### 6. Consultar saldo e extrato

```bash
curl http://localhost:3000/v1/accounts/$ACCOUNT_ID/balance -H "$AH"
curl http://localhost:3000/v1/accounts/$ACCOUNT_ID/transactions -H "$AH"
```

### 7. Pagamento via fachada genérica

```bash
curl -X POST http://localhost:3000/v1/me/payments \
  -H "$AH" -H 'Content-Type: application/json' \
  -d '{
    "paymentMethod": "PIX",
    "amount": "150.50",
    "pix": { "key": "destino@email.com" },
    "description": "Pagamento de servico"
  }'
```

Suporta `paymentMethod`: `PIX`, `QR_CODE`, `BOLETO`, `BILL`.

## Jornada JSR (Open Finance)

As rotas abaixo materializam a jornada **JSR** (dispositivo autorizado via FIDO2, sem redirect na hora do pagamento). São chamadas pela **Iniciadora** com o header `x-initiator-key`.

### 1. Criar enrollment (ITP)

```bash
curl -X POST http://localhost:3000/open-banking/itp/v2/enrollments \
  -H 'x-initiator-key: initiator-dev-secret' \
  -H 'Content-Type: application/json' \
  -d '{ "redirect_uri": "http://localhost:8100/callback" }'
```

Resposta (201) traz `enrollmentId`, `request_id` e `fidoRegistrationOptions`.

### 2. Confirmar titular (account-holder-confirmed)

```bash
curl -X PATCH http://localhost:3000/open-banking/enrollment-supports/v2/enrollment-supports/<enrollmentId>/account-holder-confirmed \
  -H 'x-initiator-key: initiator-dev-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "data": {
      "debtorAccount": { "number": "793317", "accountType": "CACC", "ibgeTownCode": "1234567" },
      "fidoUser": { "name": "joao.silva", "displayName": "Joao da Silva" }
    }
  }'
```

O header `Location` da resposta contém `code` e `state`.

### 3. Confirmar enrollment e registrar FIDO

```bash
curl -X POST http://localhost:3000/open-banking/itp/v2/enrollments/confirmations \
  -H 'x-initiator-key: initiator-dev-secret' -H 'Content-Type: application/json' \
  -d '{ "authorizationCode": "<code>", "requestId": "<state>" }'

curl -X POST http://localhost:3000/open-banking/itp/v2/enrollments/<enrollmentId>/fido-registration \
  -H 'x-initiator-key: initiator-dev-secret' -H 'Content-Type: application/json' \
  -d '{ "id": "credential-xpto", "rawId": "credential-xpto" }'
```

### 4. Criar e autorizar consentimento JSR

```bash
curl -X POST http://localhost:3000/open-banking/pisp/payments/v5/jsr/consents \
  -H 'x-initiator-key: initiator-dev-secret' -H 'Content-Type: application/json' \
  -d '{
    "accountId": "<UUID_DA_CONTA>",
    "amount": "25.00",
    "creditor": { "cpfCnpj": "01688166360", "name": "Beneficiario" },
    "payment": { "amount": "25.00", "details": { "proxy": "01688166360", "localInstrument": "DICT" } }
  }'

curl -X POST http://localhost:3000/open-banking/itp/v2/consents/<consentId>/authorise \
  -H 'x-initiator-key: initiator-dev-secret' -H 'Content-Type: application/json' \
  -d '{ "credentialId": "credential-xpto", "challenge": "<fidoChallenge>" }'
```

### 5. Iniciar e consultar o pagamento JSR

```bash
curl -X POST http://localhost:3000/open-banking/pisp/payments/v5/jsr/pix/payments \
  -H 'x-initiator-key: initiator-dev-secret' -H 'Content-Type: application/json' \
  -d '{ "consentId": "<consentId>", "authorisationFlow": "FIDO_FLOW" }'

curl http://localhost:3000/open-banking/pisp/payments/v5/jsr/pix/payments/<paymentId> \
  -H 'x-initiator-key: initiator-dev-secret'
```

## Endpoints

Legenda de autenticação: **(JWT)** = Bearer do usuário; **(INI)** = header `x-initiator-key`; **—** = pública.

### Titulares e autenticação

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/customers` | — | Cadastra titular + usuário/senha |
| POST | `/v1/auth/login` | — | Autentica e emite JWT |
| POST | `/v1/auth/authorize` | — | Inicia fluxo OAuth (retorna `request_id` + `login_url`) |
| GET | `/v1/auth/login` | — | Página de login (HTML) |
| POST | `/v1/auth/login/confirm` | — | Confirma credenciais e redireciona com `code`+`state` |
| POST | `/v1/auth/token` | — | Troca `code` por `access_token` |

### Contas

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/me/accounts` | JWT | Lista contas do usuário autenticado |
| POST | `/v1/accounts` | JWT | Cria conta corrente |
| GET | `/v1/accounts/{accountId}` | JWT | Consulta conta |
| GET | `/v1/accounts/{accountId}/balance` | JWT | Consulta saldo |
| GET | `/v1/accounts/{accountId}/transactions` | JWT | Consulta extrato |

### PIX

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/accounts/{accountId}/pix/keys` | JWT | Lista chaves PIX da conta |
| POST | `/v1/accounts/{accountId}/pix/keys` | JWT | Cadastra chave PIX (ou gera EVP) |
| POST | `/v1/accounts/{accountId}/pix/transfers` | JWT | Realiza transferência PIX |

### Pagamentos

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/me/payments` | JWT | Fachada de pagamento (PIX/QR_CODE/BOLETO/BILL) |
| POST | `/v1/aspsp/payments/consents` | JWT | Cria consentimento de pagamento (ASPSP) |
| POST | `/v1/aspsp/payments` | JWT | Submete pagamento a partir de um consent |
| GET | `/v1/aspsp/payments/{consentId}` | JWT | Consulta consentimento de pagamento |

### Jornada JSR (Open Finance)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/open-banking/itp/v2/enrollments` | INI | Cria enrollment ITP (vinculação de dispositivo) |
| GET | `/open-banking/itp/v2/enrollments/{enrollmentId}` | INI | Consulta status do enrollment |
| PATCH | `/open-banking/enrollment-supports/v2/enrollment-supports/{enrollmentId}/account-holder-confirmed` | INI | Confirma titular e gera `code`+`state` |
| POST | `/open-banking/itp/v2/enrollments/confirmations` | INI | Confirma enrollment com `authorizationCode` |
| POST | `/open-banking/itp/v2/enrollments/{enrollmentId}/fido-registration` | INI | Registra credencial FIDO do dispositivo |
| POST | `/open-banking/pisp/payments/v5/jsr/consents` | INI | Cria consentimento de pagamento JSR |
| POST | `/open-banking/itp/v2/consents/{consentId}/authorise` | INI | Autoriza consentimento com credencial FIDO |
| POST | `/open-banking/pisp/payments/v5/jsr/pix/payments` | INI | Inicia pagamento PIX JSR (sem redirect) |
| GET | `/open-banking/pisp/payments/v5/jsr/pix/payments/{paymentId}` | INI | Consulta status do pagamento JSR |

## Modelo de dados (principais entidades)

- **User** — credenciais de acesso (`username`, `passwordHash`)
- **Customer** — titular (nome, documento, e-mail), ligado a um `User`
- **Account** — conta corrente (saldo `Decimal(15,2)`, status)
- **Transaction** — ledger (CREDIT/DEBIT com `balanceBefore`/`balanceAfter`)
- **PixKey** — chave PIX associada a uma conta
- **PixTransfer** — transferência PIX (origem ↔ destino, com `endToEndId` e `consentId` únicos)
- **PixReceipt** — recebimento PIX (resolve conta pela chave e associa `enrollmentId`)
- **PaymentConsent** — consentimento de pagamento (ASPSP/JSR) com `fidoChallenge`
- **Enrollment** — vínculo de dispositivo ITP (status: CREATED → ACCOUNT_HOLDER_CONFIRMED → FIDO_REGISTERED)
- **FidoCredential** — credencial FIDO do dispositivo
- **AuthRequest** — fluxo OAuth simplificado (authorize → code → token)

## Decisões relevantes

### Valores monetários

Persistidos como `DECIMAL(15,2)` no MySQL e manipulados por `Prisma.Decimal`. O sistema não usa `float`/`double` para operações financeiras.

### Concorrência

Transferências PIX e pagamentos bloqueiam as linhas das contas com MySQL `SELECT ... FOR UPDATE` dentro da transação. Isso evita que duas operações simultâneas utilizem o mesmo saldo disponível.

### Idempotência

- **PIX**: a combinação `consentId` é única em `PixTransfer`; repetir o mesmo `consentId` retorna o transfer já existente (replay idempotente), sem novo débito.
- **PIX recebido**: o `endToEndId` é único e atua como identificador de idempotência.
- **Pagamento fachada**: gera um `consentId` interno (`uuid`) por chamada.

### PIX como única origem de crédito

Não há rota de crédito direto. Todo aumento de saldo ocorre por recebimento de PIX (transferência de outra conta interna), reforçando segregação de origens de fundos.

### Segurança das rotas JSR

As rotas `/open-banking/*` (ITP/PISP JSR) não usam JWT de usuário — são autenticadas pela **Iniciadora** via header `x-initiator-key`, validado contra `INITIATOR_SERVICE_SECRET`.

## Escopo

Este é um MVP educacional/técnico para demonstrar a jornada Open Finance (incluindo JSR) entre Iniciadora e Detentora. Um sistema bancário de produção exigiria, entre outros pontos: ledger contábil mais robusto, segregação de funções, MFA, gestão de chaves/segredos, auditoria imutável, antifraude, limites transacionais, trilha de aprovação, observabilidade, rate limiting e controles regulatórios.
