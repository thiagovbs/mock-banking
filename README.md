# Banking API

Backend bancário simplificado construído com Node.js, TypeScript, Fastify, Prisma e PostgreSQL.

## Funcionalidades

- Cadastro de titular com usuário e senha
- Login com JWT
- Criação de conta corrente
- Consulta de conta e saldo
- Crédito de teste para alimentar a conta
- Extrato de movimentações
- Pagamento com validação de saldo
- Idempotência de pagamentos
- Controle de concorrência com `SELECT ... FOR UPDATE`
- Swagger UI

> **Importante:** `POST /v1/accounts/:accountId/credits` existe somente para demonstração. Em um ambiente bancário real, crédito em conta deve ser originado por um fluxo autorizado e segregado.

## Requisitos

- Node.js 22+
- npm
- Docker + Docker Compose

## 1. Subir PostgreSQL

```bash
docker compose up -d
```

## 2. Instalar dependências

```bash
npm install
```

## 3. Configurar ambiente

O projeto já contém um `.env` de desenvolvimento. Para recriá-lo:

```bash
cp .env.example .env
```

## 4. Gerar Prisma Client

```bash
npm run prisma:generate
```

## 5. Criar banco/migration

```bash
npm run db:deploy
```

## 6. Iniciar API

```bash
npm run dev
```

API: `http://localhost:3000`

Swagger: `http://localhost:3000/docs`

Health check:

```bash
curl http://localhost:3000/health
```

# Fluxo de teste

## 1. Cadastrar titular

```bash
curl -X POST http://localhost:3000/v1/customers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Joao da Silva",
    "document": "12345678901",
    "email": "joao@example.com",
    "username": "joao.silva",
    "password": "MinhaSenha123"
  }'
```

## 2. Login

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "joao.silva",
    "password": "MinhaSenha123"
  }'
```

Copie o `accessToken` retornado:

```bash
export TOKEN='SEU_TOKEN'
```

## 3. Criar conta

```bash
curl -X POST http://localhost:3000/v1/accounts \
  -H "Authorization: Bearer $TOKEN"
```

Copie o `id` retornado:

```bash
export ACCOUNT_ID='UUID_DA_CONTA'
```

## 4. Creditar R$ 1.000,00

```bash
curl -X POST http://localhost:3000/v1/accounts/$ACCOUNT_ID/credits \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": "1000.00",
    "description": "Carga inicial para teste"
  }'
```

## 5. Consultar saldo

```bash
curl http://localhost:3000/v1/accounts/$ACCOUNT_ID/balance \
  -H "Authorization: Bearer $TOKEN"
```

## 6. Efetuar pagamento

```bash
curl -X POST http://localhost:3000/v1/accounts/$ACCOUNT_ID/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pagamento-demo-001' \
  -d '{
    "amount": "150.50",
    "beneficiary": {
      "name": "Empresa XYZ",
      "document": "12345678000190"
    },
    "description": "Pagamento de servico"
  }'
```

Repita exatamente a mesma chamada com a mesma `Idempotency-Key`. A API retornará o mesmo pagamento com:

```json
{
  "idempotentReplay": true
}
```

sem realizar um novo débito.

## 7. Consultar extrato

```bash
curl http://localhost:3000/v1/accounts/$ACCOUNT_ID/transactions \
  -H "Authorization: Bearer $TOKEN"
```

# Endpoints

| Método | Endpoint | Autenticação | Descrição |
|---|---|---|---|
| POST | `/v1/customers` | Não | Cadastra titular e credenciais |
| POST | `/v1/auth/login` | Não | Autentica usuário |
| POST | `/v1/accounts` | JWT | Cria conta corrente |
| GET | `/v1/accounts/:accountId` | JWT | Consulta conta |
| GET | `/v1/accounts/:accountId/balance` | JWT | Consulta saldo |
| GET | `/v1/accounts/:accountId/transactions` | JWT | Consulta extrato |
| POST | `/v1/accounts/:accountId/credits` | JWT | Crédito de demonstração |
| POST | `/v1/accounts/:accountId/payments` | JWT | Efetua pagamento |
| GET | `/v1/payments/:paymentId` | JWT | Consulta pagamento |

# Decisões relevantes

## Valores monetários

Persistidos como `NUMERIC(15,2)` no PostgreSQL e manipulados por `Prisma.Decimal`. O sistema não usa `float`/`double` para operações financeiras.

## Concorrência

Créditos e pagamentos bloqueiam a linha da conta com PostgreSQL `FOR UPDATE` dentro da transação SQL. Isso evita que duas operações simultâneas utilizem o mesmo saldo disponível.

## Idempotência

A combinação `(accountId, idempotencyKey)` é única no banco. Repetir uma chamada de pagamento já concluída com a mesma chave retorna o pagamento existente sem novo débito.

## Escopo

Este é um MVP educacional/técnico. Um sistema bancário de produção exigiria, entre outros pontos, ledger contábil mais robusto, segregação de funções, MFA, gestão de chaves/segredos, auditoria imutável, antifraude, limites transacionais, trilha de aprovação, observabilidade, rate limiting e controles regulatórios.
