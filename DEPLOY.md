# Publicar a Donna Semijoias — Render (grátis) + Supabase

Este projeto agora usa **Postgres**. Isso permite hospedar **de graça e com os dados salvos para sempre**:

- **Render (plano Free)** roda o site (`server.js`).
- **Supabase (plano Free)** guarda o banco de dados (produtos, categorias, banners, vendas).

> Localmente você não precisa de nada: sem `DATABASE_URL`, o app usa **PGlite** (um Postgres embutido, na pasta `./pgdata`). É só `npm install` e `npm start`.

---

## Parte 1 — Criar o banco no Supabase

1. Entre em [supabase.com](https://supabase.com) → **Sign in** (pode entrar com o GitHub) → **New project**.
2. Preencha:
   - **Name:** donna-semijoias
   - **Database Password:** crie uma senha forte e **guarde** (vai na connection string).
   - **Region:** escolha **South America (São Paulo)** se aparecer, senão a mais próxima.
3. Clique em **Create new project** e espere ~1–2 min o banco subir.
4. Pegue a **connection string**:
   - Botão **Connect** (no topo) **ou** ⚙️ **Project Settings → Database**.
   - Procure **Connection string → URI**, na aba **Connection pooling** (Session mode).
   - Vai ser algo assim:
     ```
     postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
     ```
   - Troque `[YOUR-PASSWORD]` pela senha que você criou no passo 2.

> **Importante:** use a string do **pooler** (`...pooler.supabase.com`), não a “direct connection”. A direta é só IPv6 e o Render não conecta nela.

Você **não precisa criar tabela nenhuma** no Supabase — o `server.js` cria tudo sozinho no primeiro start.

---

## Parte 2 — Publicar no Render

1. Suba o código para o **GitHub** (já feito): `git push`.
2. Em [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service** → escolha o repositório **donna-semijoias**.
3. Configuração:
   - **Language:** Node
   - **Branch:** main
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free** já serve (os dados ficam no Supabase, não somem).
4. **Environment** → adicione as variáveis:
   ```
   NODE_ENV        production
   SESSION_SECRET  uma-chave-longa-e-aleatoria
   ADMIN_EMAIL     seu-email
   ADMIN_PASSWORD  uma-senha-forte
   STORE_WHATSAPP  55 + DDD + número (só dígitos)
   DATABASE_URL    (a connection string do Supabase, com a senha)
   ```
5. **Create Web Service.** O Render instala e sobe; o `server.js` cria as tabelas e o catálogo inicial **no Supabase** automaticamente.
6. Acesse `https://SEU-APP.onrender.com` e teste: vitrine, `/login`, cadastrar produto, criar categoria, trocar banner, registrar venda, finalizar carrinho no WhatsApp.

**Não precisa de disco** (aquele passo do `/data` sumiu — o banco agora é o Supabase).

---

## Observações

- **Free “dorme”:** o serviço Free do Render hiberna após ~15 min sem acesso; a primeira visita depois disso demora alguns segundos para “acordar”. **Os dados não somem** (estão no Supabase). Se quiser sem essa espera, um plano pago do Render resolve — mas não é obrigatório.
- **Admin deslogado ao reiniciar:** a sessão fica em memória, então quando o serviço reinicia/acorda você loga de novo. Normal.
- **Backups:** o Supabase (Free) mantém o banco; para exportar, use **Database → Backups** ou o botão de exportar. Suas vendas também saem em **CSV** pelo painel de Vendas.
- **Imagens:** fotos enviadas pelo painel são gravadas no banco (base64). Para catálogos grandes, o ideal é usar **Supabase Storage** e guardar só a URL.

---

## Rodar localmente

```bash
npm install
npm start          # http://localhost:3000  (usa PGlite, cria ./pgdata)
```
Para testar com o Supabase localmente, crie um arquivo `.env` (veja `.env.example`) com o `DATABASE_URL` preenchido.

---

## E o InfinityFree?

O InfinityFree **não roda Node.js**, então não serve para rodar o `server.js`. Com o Render + Supabase (ambos grátis) você não precisa dele. Se quiser usar o InfinityFree só para a vitrine estática, dá — mas o admin/API/carrinho continuam precisando do backend no Render.
