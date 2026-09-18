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
- **Jornada de pagamento com redirecionamento (Open Finance)**: a Iniciadora cria o consentimento, o titular aprova numa tela que mostra valor e credor e deixa escolher a conta, e só então o pagamento liquida
- **Jornada JSR (Open Finance)**: ITP enrollment, registro FIDO, consentimento e pagamento sem redirect
- **Jornada de compartilhamento de dados (Open Finance)**: consentimento para outra conta ler saldo e extrato, conta a conta, com prazo definido ou indeterminado, autorizável por tela ou em texto, e revogável a qualquer momento
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
| `INITIATOR_SERVICE_SECRET` | Segredo compartilhado com a Iniciadora (header `x-initiator-key`) usado nas rotas ITP/PISP JSR e na assinatura dos webhooks |
| `WEBHOOK_ALLOWED_ORIGINS` | Origens para as quais o core pode avisar mudanca de status do consentimento, separadas por virgula. Vazio = nenhum webhook sai |
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
    "enrollmentId": "<enrollmentId de um dispositivo ativo>",
    "pix": { "key": "destino@email.com" },
    "description": "Pagamento de servico"
  }'
```

Suporta `paymentMethod`: `PIX`, `QR_CODE`, `BOLETO`, `BILL`.

`enrollmentId` é **obrigatório em PIX** — e só nele. O identificador sai da
lista de dispositivos da conta
(`GET /open-banking/itp/v2/accounts/{accountNumber}/enrollments`), tomando um
que esteja `active`. QR_CODE, BOLETO e BILL não pedem dispositivo.

O dispositivo é validado no pagamento: precisa existir, ser do pagador, estar
`FIDO_REGISTERED` e não revogado. Um dispositivo de outro titular responde
`404`, igual a um inexistente, para não confirmar que ele existe.

## Jornada JSR (Open Finance)

As rotas abaixo materializam a jornada **JSR** (dispositivo autorizado via FIDO2, sem redirect na hora do pagamento). São chamadas pela **Iniciadora** com o header `x-initiator-key`.

### 1. Criar enrollment (ITP)

```bash
curl -X POST http://localhost:3000/open-banking/itp/v2/enrollments \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' \
  -H 'Content-Type: application/json' \
  -d '{ "redirect_uri": "http://localhost:8100/callback" }'
```

Resposta (201) traz `enrollmentId`, `request_id` e `fidoRegistrationOptions`.

### 2. Confirmar titular (account-holder-confirmed)

```bash
curl -X PATCH http://localhost:3000/open-banking/enrollment-supports/v2/enrollment-supports/<enrollmentId>/account-holder-confirmed \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' \
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
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json' \
  -d '{ "authorizationCode": "<code>", "requestId": "<state>" }'

curl -X POST http://localhost:3000/open-banking/itp/v2/enrollments/<enrollmentId>/fido-registration \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json' \
  -d '{ "id": "credential-xpto", "rawId": "credential-xpto" }'
```

### 4. Criar e autorizar consentimento JSR

```bash
curl -X POST http://localhost:3000/open-banking/pisp/payments/v5/jsr/consents \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json' \
  -d '{
    "enrollmentId": "<enrollmentId>",
    "amount": "25.00",
    "creditor": { "cpfCnpj": "01688166360", "name": "Beneficiario" },
    "payment": { "amount": "25.00", "details": { "proxy": "01688166360", "localInstrument": "DICT" } }
  }'

curl -X POST http://localhost:3000/open-banking/itp/v2/consents/<consentId>/authorise \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json' \
  -d '{
    "credentialId": "credential-xpto",
    "challenge": "<fidoChallenge>",
    "signature": "<assinatura>"
  }'
```

A `signature` e um HMAC-SHA256 sobre
`jsr-fido-assertion|<consentId>|<credentialId>|<challenge>`, tendo o
`INITIATOR_SERVICE_SECRET` como chave. Os tres campos sao obrigatorios.

### 5. Iniciar e consultar o pagamento JSR

```bash
curl -X POST http://localhost:3000/open-banking/pisp/payments/v5/jsr/pix/payments \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json' \
  -d '{ "consentId": "<consentId>", "authorisationFlow": "FIDO_FLOW" }'

curl http://localhost:3000/open-banking/pisp/payments/v5/jsr/pix/payments/<paymentId> \
  -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>'
```

## Jornada de pagamento com redirecionamento (Open Finance)

A Iniciadora pede o pagamento, mas quem autoriza é o titular — vendo valor e
credor antes de confirmar. O consentimento nasce `AWAITING_AUTHORISATION`, sem
titular e sem conta (nesta altura a Iniciadora não sabe quem vai pagar), e só a
confirmação na tela o leva a `AUTHORISED`.

### 1. Iniciadora cria o consentimento

```bash
curl -X POST http://localhost:3000/v1/aspsp/payments/consents   -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json'   -d '{
    "amount": "25.00",
    "creditorName": "Beneficiario",
    "creditorDocument": "01688166360",
    "creditorKey": { "type": "CPF", "value": "01688166360" },
    "redirect_uri": "http://localhost:8100/callback"
  }'
```

A resposta traz `authorisationUrl`. `debtorDocument` é opcional: informado, só
aquele CPF consegue aprovar.

### 2. Titular aprova — modo tela

Abra a `authorisationUrl` no navegador. A tela mostra valor, credor e chave,
pede usuário e senha e deixa o titular escolher **de qual conta dele** sai o
dinheiro. Ao confirmar (ou recusar), o navegador é devolvido para
`<redirect_uri>?consentId=...&status=AUTHORISED|REJECTED`.

### 2b. Titular aprova — modo texto

Para um chatbot já logado, sem abrir navegador:

```bash
curl http://localhost:3000/v1/me/payment-consents/$CONSENT_ID   -H "Authorization: Bearer $TOKEN_TITULAR"

curl -X POST http://localhost:3000/v1/me/payment-consents/$CONSENT_ID/authorise   -H "Authorization: Bearer $TOKEN_TITULAR" -H 'Content-Type: application/json'   -d '{ "accountId": "<accountId>" }'
```

Os dois modos chamam o mesmo serviço e param no mesmo lugar: quem aprova tem
que ser o titular enderecado no consentimento, e a conta tem que ser dele.

### 3. Iniciadora acompanha sem depender do navegador

Dois caminhos, para a Iniciadora nunca ficar dependendo de o titular voltar:

```bash
# Puxar: estado atual e trilha completa
curl http://localhost:3000/v1/aspsp/payments/consents/$CONSENT_ID   -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>'

curl http://localhost:3000/v1/aspsp/payments/consents/$CONSENT_ID/events   -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>'
```

**Empurrar:** informando `webhook_uri` na criação, o core faz `POST` nele a cada
mudança de status, com o corpo assinado em `x-webhook-signature` (HMAC-SHA256
do corpo cru, chave `INITIATOR_SERVICE_SECRET`). O destino precisa estar em
`WEBHOOK_ALLOWED_ORIGINS`, senão a criação do consentimento responde `400
WEBHOOK_URI_NOT_ALLOWED` — falha alto, para a Iniciadora não acreditar que será
avisada.

```json
{
  "consentId": "...",
  "event": "CONSENT_AUTHORISED",
  "status": "AUTHORISED",
  "previousStatus": "AWAITING_AUTHORISATION",
  "paymentId": null,
  "timestamp": "2026-09-18T12:00:00.000Z"
}
```

### 4. Iniciadora submete o pagamento

```bash
curl -X POST http://localhost:3000/v1/aspsp/payments   -H 'x-initiator-key: <INITIATOR_SERVICE_SECRET>' -H 'Content-Type: application/json'   -d '{ "consentId": "<consentId>" }'
```

Consentimento pendente ou recusado responde `409 CONSENT_NOT_AUTHORISED`. É a
mesma função de liquidação usada pela jornada JSR.

## Jornada de compartilhamento de dados (Open Finance)

O titular autoriza **outra conta** a ler o **saldo** e o **extrato** das contas
que ele escolher, pelo prazo que ele definir. Os contratos seguem o padrão do
Open Finance Brasil: `Consents v3` para o consentimento e `Accounts v2` para a
leitura dos dados. A "instituição receptora" aqui é simplesmente outro cliente
do banco.

Duas coisas são deliberadas nesta jornada:

- **Escopo conta a conta.** O consentimento não vale para "as contas do
  fulano", e sim para as contas que ele marcou. Contas criadas depois ficam de
  fora.
- **Prazo opcional.** Enviar `expirationDateTime` cria um consentimento com
  validade (no máximo 12 meses, como na regulação); omiti-lo cria um
  consentimento **por prazo indeterminado**, que vale até a revogação.

### 1. Receptora pede o consentimento

Autenticada com o **JWT dela** (é ela quem quer ver os dados), informando o CPF
do titular e as permissões desejadas:

```bash
curl -X POST http://localhost:3000/open-banking/consents/v3/consents \
  -H "Authorization: Bearer $TOKEN_RECEPTORA" -H 'Content-Type: application/json' \
  -d '{
    "data": {
      "loggedUser": { "document": { "identification": "12345678901", "rel": "CPF" } },
      "permissions": ["ACCOUNTS_READ", "ACCOUNTS_BALANCES_READ", "ACCOUNTS_TRANSACTIONS_READ"]
    }
  }'
```

Sem `expirationDateTime` o consentimento é por prazo indeterminado. A resposta
nasce em `AWAITING_AUTHORISATION` e traz, em `links.redirect`, a URL da tela de
autorização.

Envie também `redirect_uri` para fechar o loop de quem iniciou a jornada: ao fim
da tela, o navegador é devolvido para `<redirect_uri>?consentId=...&status=AUTHORISED`
(ou `REJECTED`), no mesmo desenho do `redirect_uri` de `/v1/auth/authorize`. Sem
ele, a tela termina em uma página de conclusão e o desfecho é consultado pelo
`GET` do consentimento.

### 2. Titular autoriza — modo tela

O chatbot (ou o app) abre a `links.redirect` no navegador. O titular se
autentica, vê o que está sendo pedido e a validade, marca as contas e confirma:

```
GET /v1/data-sharing/consents/{consentId}/authorise
```

### 2b. Titular autoriza — modo texto

Se o titular **já está logado no chatbot**, a autorização acontece na conversa,
sem sair do chat. Primeiro o bot pergunta quais contas compartilhar:

```bash
curl http://localhost:3000/v1/data-sharing/consents/$CONSENT_ID/accounts \
  -H "Authorization: Bearer $TOKEN_TITULAR"
```

E então autoriza com as escolhidas:

```bash
curl -X POST http://localhost:3000/v1/data-sharing/consents/$CONSENT_ID/authorise \
  -H "Authorization: Bearer $TOKEN_TITULAR" -H 'Content-Type: application/json' \
  -d '{ "accountIds": ["'"$ACCOUNT_ID"'"] }'
```

Os dois modos caem no mesmo serviço, com as mesmas validações e o mesmo
resultado: quem autoriza tem que ser o titular endereçado no consentimento, e
as contas têm que ser dele.

### 3. Receptora lê saldo e extrato

O consentimento viaja no header `x-consent-id` (no OFB ele vem no escopo do
token); o JWT continua identificando a receptora:

```bash
curl http://localhost:3000/open-banking/accounts/v2/accounts \
  -H "Authorization: Bearer $TOKEN_RECEPTORA" -H "x-consent-id: $CONSENT_ID"

curl http://localhost:3000/open-banking/accounts/v2/accounts/$ACCOUNT_ID/balances \
  -H "Authorization: Bearer $TOKEN_RECEPTORA" -H "x-consent-id: $CONSENT_ID"

curl http://localhost:3000/open-banking/accounts/v2/accounts/$ACCOUNT_ID/transactions \
  -H "Authorization: Bearer $TOKEN_RECEPTORA" -H "x-consent-id: $CONSENT_ID"
```

### 4. Titular acompanha e revoga

```bash
# O que concedi e o que recebi
curl http://localhost:3000/v1/me/data-sharing/consents -H "Authorization: Bearer $TOKEN_TITULAR"

# Revogar
curl -X DELETE http://localhost:3000/v1/me/data-sharing/consents/$CONSENT_ID \
  -H "Authorization: Bearer $TOKEN_TITULAR"
```

Depois da revogação, a próxima leitura da receptora já responde `403`.

### O mesmo dado, com o consentId no caminho

Nem todo cliente controla headers — as tools MCP geradas a partir do OpenAPI, por
exemplo, mandam só argumentos. Por isso as mesmas leituras existem com o
`consentId` no caminho, sob `/v1/data-sharing/consents/{consentId}/data`:

```bash
curl http://localhost:3000/v1/data-sharing/consents/$CONSENT_ID/data/accounts/$ACCOUNT_ID/balances   -H "Authorization: Bearer $TOKEN_RECEPTORA"
```

Mesmo handler, mesmas regras de consentimento; muda só onde o `consentId` viaja.

### A jornada não precisa acontecer de uma vez só

Consentimento criado agora pode ser autorizado depois, em outra sessão e por
outro canal. O pedido nasce endereçado a um **documento**, então o titular o
encontra quando entrar, sem precisar de link nenhum:

```bash
# Titular: o que está pendente de autorização minha
curl "http://localhost:3000/v1/me/data-sharing/consents?status=AWAITING_AUTHORISATION"   -H "Authorization: Bearer $TOKEN_TITULAR"

# Receptora: acompanha o desfecho do pedido que fez
curl http://localhost:3000/open-banking/consents/v3/consents/$CONSENT_ID   -H "Authorization: Bearer $TOKEN_RECEPTORA"
```

O filtro aceita lista (`?status=AWAITING_AUTHORISATION,AUTHORISED`) ou o parâmetro
repetido; sem ele, vêm todos. Cada item traz `granteeName` — quem está pedindo — e
`granterName`, nulo enquanto ninguém autorizou, porque até lá o pedido conhece
apenas o documento. É o que permite perguntar *"o Thiago Veloso quer ver seu
saldo, autorizo?"* em vez de exibir um `consentId` para o usuário.

Isso permite montar a jornada como caixa de entrada — a receptora pede, o titular
resolve quando quiser — em vez de exigir que os dois lados estejam na mesma
conversa ao mesmo tempo.

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
| GET | `/v1/pix/transfers/{pixTransferId}` | JWT | Comprovante da transferência (pagador e recebedor) |

### Pagamentos

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/me/payments` | JWT | Fachada de pagamento (PIX/QR_CODE/BOLETO/BILL) |
| GET | `/v1/payments/{paymentId}` | JWT | Consulta um pagamento registrado |
| POST | `/v1/aspsp/payments/consents` | Iniciadora | Cria consentimento de pagamento, pendente de aprovação |
| GET | `/v1/aspsp/payments/consents/{consentId}` | Iniciadora | Consulta o consentimento e seu status |
| GET | `/v1/aspsp/payments/consents/{consentId}/events` | Iniciadora | Trilha do consentimento: o que foi tentado, por quem, e o que passou |
| POST | `/v1/aspsp/payments` | Iniciadora | Submete o pagamento de um consentimento **já aprovado** |
| GET | `/v1/aspsp/payments/consents/{consentId}/authorise` | Aberta | Tela onde o titular revisa e aprova |
| POST | `/v1/aspsp/payments/consents/{consentId}/authorise/login` | Aberta | Passo 1 da tela: identificação |
| POST | `/v1/aspsp/payments/consents/{consentId}/authorise/confirm` | Aberta | Passo 2 da tela: escolhe a conta e aprova |
| POST | `/v1/aspsp/payments/consents/{consentId}/authorise/reject` | Aberta | Passo 2 da tela: recusa |
| GET | `/v1/me/payment-consents/{consentId}` | JWT | Modo texto: o que está sendo pedido + contas do titular |
| POST | `/v1/me/payment-consents/{consentId}/authorise` | JWT | Modo texto: aprova indicando `accountId` |
| POST | `/v1/me/payment-consents/{consentId}/reject` | JWT | Modo texto: recusa |

### Jornada JSR (Open Finance)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/open-banking/itp/v2/enrollments` | INI | Cria enrollment ITP (vinculação de dispositivo) |
| GET | `/open-banking/itp/v2/enrollments/{enrollmentId}` | INI | Consulta status do enrollment |
| DELETE | `/open-banking/itp/v2/enrollments/{enrollmentId}` | INI | Revoga o dispositivo vinculado |
| PATCH | `/open-banking/enrollment-supports/v2/enrollment-supports/{enrollmentId}/account-holder-confirmed` | INI | Confirma titular e gera `code`+`state` |
| POST | `/open-banking/itp/v2/enrollments/confirmations` | INI | Confirma enrollment com `authorizationCode` |
| POST | `/open-banking/itp/v2/enrollments/{enrollmentId}/fido-registration` | INI | Registra credencial FIDO do dispositivo |
| POST | `/open-banking/pisp/payments/v5/jsr/consents` | INI | Cria consentimento JSR a partir de um `enrollmentId` |
| POST | `/open-banking/itp/v2/consents/{consentId}/authorise` | INI | Autoriza com credencial FIDO, challenge e assinatura |
| POST | `/open-banking/pisp/payments/v5/jsr/pix/payments` | INI | Inicia pagamento PIX JSR (sem redirect) |
| GET | `/open-banking/pisp/payments/v5/jsr/pix/payments/{paymentId}` | INI | Consulta status do pagamento JSR |

### Compartilhamento de dados (Open Finance)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/open-banking/consents/v3/consents` | JWT (receptora) | Cria consentimento de leitura (sem `expirationDateTime` = prazo indeterminado) |
| GET | `/open-banking/consents/v3/consents/{consentId}` | JWT | Consulta o consentimento (receptora ou titular) |
| DELETE | `/open-banking/consents/v3/consents/{consentId}` | JWT | Revoga ou recusa o consentimento |
| GET | `/v1/data-sharing/consents/{consentId}/authorise` | — | Tela de autorização (HTML) |
| POST | `/v1/data-sharing/consents/{consentId}/authorise` | JWT (titular) | Autoriza em modo texto, com `accountIds` |
| GET | `/v1/data-sharing/consents/{consentId}/accounts` | JWT (titular) | Contas que o titular pode oferecer neste consentimento |
| GET | `/v1/me/data-sharing/consents` | JWT | Consentimentos concedidos e recebidos (`?status=` filtra; traz `granteeName`) |
| DELETE | `/v1/me/data-sharing/consents/{consentId}` | JWT | Revoga um consentimento concedido |
| GET | `/open-banking/accounts/v2/accounts` | JWT + `x-consent-id` | Contas dentro do consentimento |
| GET | `/open-banking/accounts/v2/accounts/{accountId}` | JWT + `x-consent-id` | Identificação da conta compartilhada |
| GET | `/open-banking/accounts/v2/accounts/{accountId}/balances` | JWT + `x-consent-id` | Saldo da conta compartilhada |
| GET | `/open-banking/accounts/v2/accounts/{accountId}/transactions` | JWT + `x-consent-id` | Extrato da conta compartilhada |
| GET | `/v1/data-sharing/consents/{consentId}/data/accounts` | JWT (receptora) | Contas do consentimento, com o `consentId` no caminho |
| GET | `/v1/data-sharing/consents/{consentId}/data/accounts/{accountId}` | JWT (receptora) | Identificação da conta compartilhada |
| GET | `/v1/data-sharing/consents/{consentId}/data/accounts/{accountId}/balances` | JWT (receptora) | Saldo, com o `consentId` no caminho |
| GET | `/v1/data-sharing/consents/{consentId}/data/accounts/{accountId}/transactions` | JWT (receptora) | Extrato, com o `consentId` no caminho |

## Modelo de dados (principais entidades)

- **User** — credenciais de acesso (`username`, `passwordHash`)
- **Customer** — titular (nome, documento, e-mail), ligado a um `User`
- **Account** — conta corrente (saldo `Decimal(15,2)`, status)
- **Transaction** — ledger (CREDIT/DEBIT com `balanceBefore`/`balanceAfter`)
- **Payment** — registro consultável de um pagamento da fachada, nos quatro métodos
- **PixKey** — chave PIX associada a uma conta
- **PixTransfer** — transferência PIX (origem ↔ destino, com `endToEndId` e `consentId` únicos)
- **PaymentConsent** — consentimento de pagamento (ASPSP/JSR). Na jornada com redirecionamento nasce sem titular e sem conta (AWAITING_AUTHORISATION → AUTHORISED → PAYMENT_SUBMITTED → COMPLETED, ou REJECTED); na JSR nasce CREATED com `fidoChallenge`
- **PaymentConsentEvent** — trilha do consentimento: ator, desfecho, motivo da recusa e status antes/depois de cada passo, inclusive das tentativas barradas
- **Enrollment** — vínculo de dispositivo ITP (status: CREATED → ACCOUNT_HOLDER_CONFIRMED → FIDO_REGISTERED)
- **FidoCredential** — credencial FIDO do dispositivo
- **AuthRequest** — fluxo OAuth simplificado (authorize → code → token)
- **DataSharingConsent** — consentimento de compartilhamento de dados (permissões, validade opcional, `redirectUri` opcional, status AWAITING_AUTHORISATION → AUTHORISED → REJECTED)
- **DataSharingConsentAccount** — contas que o titular colocou no escopo do consentimento
- **DataSharingAccess** — trilha de cada leitura feita pela receptora sob um consentimento

## Decisões relevantes

### Valores monetários

Persistidos como `DECIMAL(15,2)` no MySQL e manipulados por `Prisma.Decimal`. O sistema não usa `float`/`double` para operações financeiras.

### Concorrência

Transferências PIX e pagamentos bloqueiam as linhas das contas com MySQL `SELECT ... FOR UPDATE` dentro da transação. Isso evita que duas operações simultâneas utilizem o mesmo saldo disponível.

### Idempotência

- **PIX**: a combinação `consentId` é única em `PixTransfer`; repetir o mesmo `consentId` retorna o transfer já existente (replay idempotente), sem novo débito.
- **PIX recebido**: o `endToEndId` é único e atua como identificador de idempotência.
- **Pagamento fachada**: o header `Idempotency-Key` é opcional e único por conta
  (`@@unique([accountId, idempotencyKey])`). Repetir a chamada com a mesma chave
  devolve o pagamento já registrado, com `200` e `idempotentReplay: true`, sem
  novo débito. Sem o header, cada chamada é uma operação nova.

### Recebedor declarado x dono da chave

A chave PIX resolve a conta de destino. Quando o consentimento declara o
documento do recebedor (`creditor.cpfCnpj` na jornada JSR, `creditorDocument`
no ASPSP), a liquidação confere esse documento contra o titular real da chave e
recusa com `422 CREDITOR_MISMATCH` se divergir — nada de dinheiro se move.

É a proteção contra a chave ter mudado de dono entre o momento em que o
recebedor foi exibido ao pagador e a liquidação. O nome (`creditor.name`) não
entra na conferência: texto livre geraria recusa por diferença de grafia. Ele
segue apenas como descrição do lançamento quando o pagador não informa uma.

Sem documento declarado, não há o que conferir e a liquidação segue pela chave.

### PIX como única origem de crédito

Não há rota de crédito direto. Todo aumento de saldo ocorre por recebimento de PIX (transferência de outra conta interna), reforçando segregação de origens de fundos.

### Segurança das rotas JSR

As rotas `/open-banking/*` (ITP/PISP JSR) não usam JWT de usuário — são autenticadas pela **Iniciadora** via header `x-initiator-key`, validado contra `INITIATOR_SERVICE_SECRET`.

O **enrollment é a âncora da jornada**. Titular e conta são fixados nele no
`account-holder-confirmed` e, daí em diante, o consentimento deriva do
enrollment — o `accountId` no corpo é apenas conferido, e divergência é
recusada com `400`. Autorizar exige a credencial daquele enrollment
específico, o challenge do consentimento (de uso único, limpo ao autorizar) e
uma assinatura HMAC que amarra os três. O dispositivo é revalidado no momento
do débito, então revogar impede pagamentos autorizados antes.

A assinatura **não é WebAuthn**: Iniciadora e Detentora são dois backends que
compartilham um segredo, e é o mesmo segredo que já autentica a Iniciadora.
Ela prova conhecimento do challenge e da credencial corretos, não a
participação do dispositivo do titular.

### Pagamento iniciado por terceiro: consentimento antes do dinheiro

As duas jornadas que nascem na Iniciadora terminam na mesma função,
`settlePaymentConsent`, e ela só liquida um consentimento `AUTHORISED` com
titular e conta vinculados. O que muda entre elas é **como** se chega a
`AUTHORISED`:

- **Com redirecionamento**: o consentimento nasce `AWAITING_AUTHORISATION` e o
  titular aprova numa tela da Detentora, onde vê valor e credor e escolhe a
  conta de débito. Antes, ele apenas fazia login e o consentimento era criado
  já autorizado — a pessoa autenticava sem nunca ver o que estava pagando.
- **Sem redirecionamento (JSR)**: o consentimento nasce `CREATED` preso a um
  dispositivo **já aprovado** (enrollment `FIDO_REGISTERED`, não revogado), e a
  aprovação é a assertion FIDO sobre aquele consentimento. O dispositivo é
  reconferido na autorização **e** na liquidação: revogar corta pagamento em
  andamento.

Pagamento que o próprio titular inicia na Detentora (`/v1/me/payments`) não
passa por consentimento: quem pede e quem autoriza são a mesma pessoa, já
autenticada.

### A trilha do consentimento, e por que ela é separada do status

`PaymentConsent` guarda **onde** o consentimento está; `PaymentConsentEvent`
guarda **como** ele chegou lá. A separação existe porque o que mais interessa
auditar não muda o status: uma submissão barrada por consentimento pendente, uma
aprovação tentada com o CPF errado, uma assertion FIDO inválida — nada disso
deixa marca no consentimento. Sem os eventos, essas tentativas simplesmente não
aconteceram do ponto de vista de quem audita.

Cada evento registra ator (`INITIATOR`/`HOLDER`/`SYSTEM`), desfecho
(`ACCEPTED`/`REFUSED`), o código do erro quando recusado, e o status antes e
depois. As duas jornadas gravam na mesma tabela, então a leitura é uma só.

Gravar o evento e avisar a Iniciadora vivem na mesma função, de propósito: não
há como um acontecer sem o outro e as duas visões divergirem. E os dois são
best-effort — registrar e avisar são consequências da operação, não
pré-requisitos dela, então uma falha ali nunca derruba um pagamento.

### Compartilhamento de dados: o consentimento é o porteiro

Toda leitura feita pela receptora passa por uma única função, que só devolve
dado se o consentimento estiver `AUTHORISED`, dentro da validade, com a
permissão exigida pela rota e com a conta dentro do escopo marcado pelo
titular. Uma conta fora do escopo responde `404`, não `403`: ela não deve nem
existir aos olhos da receptora.

A **expiração é aplicada na leitura**, não por job agendado: um consentimento
vencido é gravado como `REJECTED`/`CONSENT_EXPIRED` na própria requisição que o
encontrou, antes de qualquer resposta. Assim o dado para de fluir na hora certa
mesmo sem agendador rodando.

Não existem status `REVOKED` nem `EXPIRED`. Como no OFB, revogação e expiração
levam a `REJECTED`, distinguidas por `rejection.reason.code`
(`CUSTOMER_MANUALLY_REVOKED`, `CONSENT_EXPIRED`) — uma máquina de estados só,
mais fácil de auditar.

O consentimento nasce endereçado a um **documento**, e o vínculo com o usuário
real (`granterUserId`) só é gravado na autorização. Quem autoriza precisa ser o
dono daquele documento; caso contrário qualquer usuário logado poderia assumir
um pedido feito para outra pessoa.

Esse endereçamento por documento é o que torna a jornada **assíncrona**: o pedido
existe antes de o titular aparecer, e ele o encontra em
`GET /v1/me/data-sharing/consents` quando entrar, sem depender de ter recebido o
link. Os dois lados não precisam estar na mesma sessão.

O `consentId` é aceito em três lugares — header `x-consent-id` (forma do OFB),
caminho da URL (`/v1/data-sharing/consents/{consentId}/data/...`) e, na
autorização, no próprio path. É o mesmo handler nos três casos: quem só consegue
mandar parâmetros no caminho, como uma tool MCP gerada do OpenAPI, não fica de
fora.

## Escopo

Este é um MVP educacional/técnico para demonstrar a jornada Open Finance (incluindo JSR) entre Iniciadora e Detentora. Um sistema bancário de produção exigiria, entre outros pontos: ledger contábil mais robusto, segregação de funções, MFA, gestão de chaves/segredos, auditoria imutável, antifraude, limites transacionais, trilha de aprovação, observabilidade, rate limiting e controles regulatórios.
