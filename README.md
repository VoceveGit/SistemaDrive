# Despacho — Ingestão de planilhas (Voceve)

Sistema web para monitorar pastas do Google Drive de clientes, comparar planilhas recebidas e enviar dados novos para MySQL/PostgreSQL de destino.

## Deploy (um Web Service no Render)

Front e API no **mesmo** serviço: o Express serve o `frontend/dist` em produção.

| Serviço | Função |
|---------|--------|
| **Neon** (ou Postgres) | Banco interno (usuários, empresas, histórico) |
| **Render** (1× Web Service) | API + frontend estático + WebSocket |
| **MySQL EXTRACTOR** | Banco de destino das planilhas (configurado no app) |

### Build / Start no Render

- **Root Directory:** (vazio — raiz do repo)
- **Build Command:** `cd frontend && npm install && npm run build && cd ../backend && npm install && npm run build`
- **Start Command:** `cd backend && npm start`

Ou use o `render.yaml` na raiz.

### Variáveis essenciais no Render

- `NODE_ENV=production`
- `DATABASE_URL` — Postgres interno (Neon)
- `JWT_SECRET`
- `FRONTEND_URL` — URL pública do Render (ex.: `https://despacho.onrender.com`)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`
- Credenciais Google Drive (service account) conforme o ambiente

> **Não** commitar `.env` nem `drive-credentials.json`.

## Pré-requisitos

- Node.js 20+
- Conta [Neon](https://neon.tech) (PostgreSQL)
- Conta [Render](https://render.com)
- Google Cloud: Drive API + Service Account

## Setup local

### 1. Banco de dados (Neon)

1. Crie um projeto no Neon
2. Copie a connection string (`DATABASE_URL`)

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edite .env com DATABASE_URL, JWT_SECRET, credenciais Google
npm install
npx prisma db push
npm run dev
```

API em `http://localhost:3001`

**Usuário admin padrão** (criado automaticamente na primeira execução):
- E-mail: `admin@voceve.com`
- Senha: `admin123` (altere via `ADMIN_PASSWORD` no `.env`)

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

App em `http://localhost:5173`

## Deploy no Render + Neon

### Neon
1. Crie o banco e copie `DATABASE_URL`
2. Use a mesma URL no backend no Render

### Backend (Render Web Service)
- **Build:** `cd backend && npm install && npm run build`
- **Start:** `cd backend && npm start`
- **Variáveis de ambiente:**
  - `DATABASE_URL` — connection string do Neon
  - `JWT_SECRET` — chave segura
  - `FRONTEND_URL` — URL do frontend no Render (ex: `https://spreadsheet-sync.onrender.com`)
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI` — `https://SEU-BACKEND.onrender.com/api/auth/google/callback`
  - `ADMIN_EMAIL`, `ADMIN_PASSWORD`

### Frontend (Render Static Site)
- **Build:** `cd frontend && npm install && npm run build`
- **Publish directory:** `frontend/dist`
- **Variáveis:**
  - `VITE_API_URL` — `https://SEU-BACKEND.onrender.com/api`
  - `VITE_SOCKET_URL` — `https://SEU-BACKEND.onrender.com`

## Fluxo de uso

1. **Configurações** → Conecte o banco de destino (PostgreSQL/MySQL) e o Google Drive
2. **Empresas** → Cadastre cada cliente com ID da pasta compartilhada no Drive
3. Por empresa, configure **tabela destino** e **coluna de data** (janela de 3 dias)
4. Cliente envia planilha na pasta → sistema detecta (polling 2 min) → notificação
5. No **Dashboard**, clique no card → veja histórico → expanda linha → comparativo verde/âmbar
6. **Aprovar** → **Enviar tudo** (ou use **Modo Teste** para 1 linha antes)

## Estrutura

```
SistemaDrive/
├── backend/          # API Express + Prisma + Socket.io
├── frontend/         # React + Vite + Tailwind
└── README.md
```

Documentação da API: [backend/docs/API.md](backend/docs/API.md)
