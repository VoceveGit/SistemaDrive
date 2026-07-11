# API — SpreadsheetSync

Base URL: `/api`

Autenticação: `Authorization: Bearer <token>` (exceto rotas públicas)

## Rotas públicas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status da API |
| POST | `/auth/login` | Login `{ email, password }` → `{ token, user }` |
| GET | `/auth/google` | Inicia OAuth Google Drive |
| GET | `/auth/google/callback` | Callback OAuth |

## Autenticação

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/auth/me` | Usuário logado |

## Configurações

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/settings` | Configurações (senha mascarada) |
| POST | `/settings` | Salvar banco de destino |
| POST | `/settings/test-connection` | Testar conexão |
| GET | `/settings/google/status` | Status Google |
| POST | `/settings/google/disconnect` | Desconectar Google |

## Dashboard

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/dashboard/stats` | Métricas globais |
| GET | `/dashboard/connection` | Status conexão banco destino |

## Empresas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/companies` | Lista ativas com contadores |
| GET | `/companies/all` | Lista todas |
| POST | `/companies` | Criar `{ name, color, googleFolderId }` |
| GET | `/companies/:id` | Detalhe + stats |
| PUT | `/companies/:id` | Atualizar (tabela, dateColumn, etc.) |
| DELETE | `/companies/:id` | Desativar (soft delete) |
| GET | `/companies/:id/tables` | Tabelas do banco destino |
| GET | `/companies/:id/columns?table=X` | Colunas da tabela |
| GET | `/companies/:id/spreadsheets` | Histórico de planilhas |

## Planilhas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/spreadsheets/:id/diff` | Comparativo dupla camada |
| POST | `/spreadsheets/:id/approve` | Aprovar planilha |
| POST | `/spreadsheets/:id/send` | Enviar linhas `mustSend` ao banco |
| POST | `/spreadsheets/:id/send-test` | Envio teste `{ mode, selectedRows? }` |

## WebSocket

Evento `new_spreadsheet`:
```json
{ "companyId", "companyName", "fileName", "spreadsheetId" }
```

## Diff — estados das linhas

| Campo | Significado |
|-------|-------------|
| `isNew` | Nova vs planilha anterior (hash SHA-256) |
| `isNewInDb` | Ausente na janela de 3 dias do banco |
| `mustSend` | `isNew && isNewInDb` — será inserida no envio |
