# Publicação e Banco de Dados — Donna Semijoias

Este guia responde duas perguntas: **o que muda no InfinityFree** e **o que muda no banco de dados**.

---

## 1. Resumo direto

Este site tem **duas partes**:

| Parte | Arquivos | Precisa de quê |
|-------|----------|----------------|
| **Frontend (vitrine)** | `index.html`, `styles.css`, `assets/` | Só arquivos estáticos |
| **Backend (loja de verdade)** | `server.js` + `database.db` | **Node.js rodando 24h** |

O **backend** é o que faz funcionar: login do admin, cadastro de produtos, categorias, banners, vendas, carrinho com WhatsApp e todas as rotas `/api/*`.

> ⚠️ **O InfinityFree NÃO roda Node.js.** Ele só serve HTML/CSS/imagens e PHP. Ou seja, sozinho, o InfinityFree **não** consegue rodar `server.js`. Sem o backend, a vitrine abre mas fica sem produtos, sem categorias, sem banners editáveis e sem admin.

---

## 2. O que fazer no InfinityFree

Você tem 3 caminhos. Escolha **um**.

### ✅ Opção A (mais simples e recomendada): hospedar tudo no Render
Hospede o projeto inteiro (frontend **+** backend juntos, exatamente como está hoje). O Render serve a vitrine e as APIs no mesmo endereço — o InfinityFree **não é usado**.

O código já está preparado para o Render:
- `app.set('trust proxy', 1)` — faz o **login do admin funcionar** atrás do HTTPS do Render.
- `DATABASE_PATH` — permite apontar o banco para um **disco persistente**.
- usa `process.env.PORT` — o Render define a porta automaticamente.

**Passo a passo:**

1. **Suba o código para o GitHub.**
   - Crie um repositório e faça push desta pasta. Confirme que o `.gitignore` ignora `node_modules` e `database.db` (não versione o banco).

2. **Crie o serviço no Render.**
   - Entre em [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service** → conecte o GitHub e escolha o repositório.

3. **Configurações do serviço:**
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** para uma loja de verdade escolha um plano **pago (Starter, ~US$7/mês)**. O plano **Free não guarda o banco** (ver passo 5) e “dorme” após 15 min de inatividade.

4. **Variáveis de ambiente** (aba **Environment** → Add Environment Variable):
   ```
   NODE_ENV=production
   SESSION_SECRET=<chave-longa-aleatoria>
   ADMIN_EMAIL=<seu-email>
   ADMIN_PASSWORD=<senha-forte>
   STORE_WHATSAPP=55DDNNNNNNNNN
   DATABASE_PATH=/data/database.db
   ```

5. **Disco persistente** (aba **Disks** → Add Disk) — **essencial** para não perder produtos/vendas a cada deploy:
   - **Name:** `data`
   - **Mount Path:** `/data`
   - **Size:** 1 GB já basta.
   - Isso combina com `DATABASE_PATH=/data/database.db` do passo 4. (Disco persistente exige plano pago.)

6. **Create Web Service.** O Render roda `npm install` (compila `bcrypt`/`sqlite3`) e sobe o app. Na primeira vez o `server.js` cria as tabelas e o catálogo inicial sozinho.

7. **Teste** em `https://SEU-APP.onrender.com`:
   - vitrine com produtos, categorias e banners;
   - `/login` → entrar no painel → cadastrar produto, criar categoria, trocar banner, registrar venda;
   - finalizar o carrinho pelo WhatsApp.

**Observações:**
- **Sessões em memória:** o admin é deslogado quando o serviço reinicia (deploy/restart). Para uma loja pequena tudo bem; se incomodar, dá para persistir a sessão (ex.: `connect-sqlite3`).
- **Plano Free:** só serve para testar — sem disco persistente o `database.db` é recriado (com o catálogo de exemplo) a cada deploy/hibernação, então tudo que você cadastrar some. Para manter os dados, use o plano pago + disco (passo 5) **ou** migre para Postgres/Supabase (Opção C).
- **Railway/Fly.io** seguem a mesma ideia: Node + variáveis de ambiente + volume persistente apontado por `DATABASE_PATH`.

### Opção B: frontend no InfinityFree + backend no Render
Se você faz questão de manter o domínio/host do InfinityFree para a vitrine:
1. Publique no InfinityFree apenas: `index.html`, `styles.css`, `assets/` e o `.htaccess`.
2. Hospede o `server.js` no Render (como na Opção A).
3. No `index.html`, troque as chamadas relativas (`/api/...`, `/contato`) por **URLs absolutas** do backend, por exemplo `https://donna.onrender.com/api/products`. As linhas a alterar usam `fetch('/api/...')`.
4. No `server.js`, libere **CORS** para o domínio do InfinityFree (hoje não há CORS porque tudo é servido pela mesma origem). É preciso `npm install cors` e habilitar só para o seu domínio.
5. As páginas de admin (`/admin/...`, `login.html`, etc.) ficam **no backend** (Render), não no InfinityFree, porque dependem de sessão.

### Opção C: InfinityFree + Supabase (sem servidor Node)
Migração maior: troca o `server.js`/SQLite por **Supabase** (banco Postgres + Auth + Storage). A vitrine estática fica no InfinityFree e fala direto com o Supabase. É a melhor opção “100% InfinityFree”, mas exige reescrever a camada de dados. Só vale a pena se você não quiser manter um backend Node.

### Sobre o `.htaccess`
O `.htaccess` incluído só ajuda o InfinityFree a **não quebrar** as URLs diretas (`/login`, `/admin`) servindo os HTML corretos. Ele **não** cria o backend — as rotas `/api/*` continuam sem funcionar no InfinityFree puro.

---

## 3. O que muda no banco de dados

### Como está hoje
- Banco: **SQLite**, no arquivo **`database.db`** (na raiz do projeto).
- **Você não precisa criar nada manualmente.** Ao iniciar, o `server.js` cria/atualiza sozinho todas as tabelas e insere os dados iniciais:
  - `products` (produtos, com preço, promoção, estoque, imagens)
  - `categories` (categorias da vitrine — **novo**)
  - `store_meta` (guarda os banners/textos do site em `site_content` — **novo**)
  - `admins` (login do painel)
  - `sales` (vendas)
  - `customers` (cadastros)

### O que você precisa garantir na publicação
1. **Persistência do arquivo `database.db`.**
   Em serviços como Render/Railway, o disco é apagado a cada novo deploy. Sem um **disco persistente**, você perde produtos, categorias, banners e vendas a cada atualização. → No Render, adicione um **Persistent Disk** e aponte o app para gravar o `database.db` nele.

2. **Backup.** Baixe o `database.db` de tempos em tempos — é onde ficam todos os seus produtos, categorias, banners e histórico de vendas.

3. **Imagens grandes.** Fotos enviadas pelo painel (produtos, categorias e banners) são gravadas **dentro do banco** como base64. Muitas fotos grandes incham o `database.db` e deixam a API mais lenta. Para catálogos grandes, o ideal é subir as imagens para **Storage** (ex.: Supabase Storage, Cloudinary, S3) e guardar só a URL. Para uma loja pequena, o modo atual funciona bem.

### Se um dia migrar de SQLite para outro banco
- **InfinityFree oferece MySQL**, mas ele **não aceita conexão remota** de um backend hospedado fora (Render/Railway). Então o MySQL do InfinityFree **não serve** para o backend Node deste projeto.
- Se quiser um banco gerenciado, use **Postgres (Supabase/Neon/Render Postgres)**. Isso exige trocar o driver `sqlite3` por `pg` no `server.js` e recriar as tabelas (a estrutura é a mesma listada acima).

---

## 4. Variáveis de ambiente (obrigatório em produção)

Defina no painel do serviço de hospedagem (Render/Railway) — **não** deixe os valores padrão:

```
NODE_ENV=production
SESSION_SECRET=<uma-chave-longa-e-aleatoria>
ADMIN_EMAIL=<seu-email-de-admin>
ADMIN_PASSWORD=<uma-senha-forte>
STORE_WHATSAPP=55DDNNNNNNNNN   (número que recebe os pedidos, só dígitos)
PORT=3000
```

- `SESSION_SECRET` e `ADMIN_PASSWORD` **precisam** ser trocados — os valores padrão são públicos (estão no README).
- `NODE_ENV=production` ativa o cookie de sessão seguro (só HTTPS).
- `STORE_WHATSAPP` é o número que recebe a mensagem do carrinho.

---

## 5. Checklist rápido

- [ ] Escolhi onde roda o backend (Render/Railway) — InfinityFree **não** roda Node.
- [ ] Configurei as variáveis de ambiente (senha e secret trocados).
- [ ] Configurei **disco persistente** para o `database.db`.
- [ ] Fiz um backup do `database.db`.
- [ ] (Se usei a Opção B) Troquei os `fetch('/api/...')` por URL absoluta e habilitei CORS.
- [ ] Testei: login do admin, cadastro de produto, criar categoria, trocar banner, registrar venda, finalizar carrinho pelo WhatsApp.
