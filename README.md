# Donna Semijoias

E-commerce de semijoias em HTML/CSS/JavaScript com backend Node.js, Express e **Postgres**, login administrativo protegido, CRUD de produtos, categorias, banners e vendas.

## Como executar

```bash
npm install
npm start
```

Roda em `http://localhost:3000`. **Não precisa instalar banco:** sem `DATABASE_URL`, o app usa **PGlite** (um Postgres embutido, gravado em `./pgdata`).

Para produção (ou testar com o Supabase), defina `DATABASE_URL` com a connection string do Postgres. Variaveis recomendadas:

```bash
$env:NODE_ENV="production"
$env:SESSION_SECRET="uma-chave-grande"
$env:ADMIN_EMAIL="admin@sualoja.com"
$env:ADMIN_PASSWORD="uma-senha-forte"
$env:STORE_WHATSAPP="5599999999999"
$env:DATABASE_URL="postgresql://...supabase.com:5432/postgres"
npm start
```

Publicação grátis (Render + Supabase): veja **[DEPLOY.md](DEPLOY.md)**.

## Acesso administrativo

- Rota escondida: `/admin`
- Login: e-mail e senha configurados por variavel de ambiente.
- Credencial local inicial, se nenhuma variavel for definida: `admin@donna.local` / `DonnaAdmin2026!`
- Produtos: `/admin/produtos`
- Vendas: `/admin/vendas`

O link de admin nao aparece na loja publica. Quem acessa `/admin` sem sessao e redirecionado para `/login`.

## Funcionalidades

### Loja publica
- Vitrine carregada do banco (Postgres) com busca, filtro por categoria e ordenacao (destaques, preco, maiores descontos, nome).
- Precos promocionais com preco original riscado, selo de desconto (%) e economia calculada.
- Controle de estoque na vitrine: selo "Esgotado", aviso de "Ultimas unidades" e botao de compra desabilitado quando sem estoque.
- Lista de favoritos (coracao no produto) persistida no navegador, com contador e filtro "somente favoritos".
- Modal de produto com galeria de imagens (miniaturas), preco, disponibilidade e favoritar.
- Sacola com barra de progresso para o frete especial (R$ 299), total de economia e mensagem de WhatsApp detalhada (itens, quantidades, precos, subtotais, total e economia).
- Notificacoes (toast), estados de carregamento (skeletons), botao "voltar ao topo" e favicon da marca.

### Administracao
- Login administrativo com bcrypt e sessao HTTP-only.
- Cadastro, edicao e exclusao de produtos.
- Gerenciamento de multiplas imagens por produto, com preview, imagem principal, remocao e reordenacao.
- Status publicado/rascunho, destaque, promocao, preco promocional e estoque.
- Indicadores (produtos, destaques, em promocao, estoque total, esgotados) e selos de estoque/promocao na listagem.
- Painel de vendas: registrar nova venda (com baixa automatica de estoque), alterar status, excluir, exportar CSV e metricas que desconsideram pedidos cancelados.
- Fallback visual para imagens quebradas.

## Banco de dados

- **Local:** PGlite (Postgres embutido), gravado em `./pgdata`. Zero configuracao.
- **Producao:** Postgres gerenciado (recomendado: **Supabase**, plano grátis), via `DATABASE_URL`.
- O `server.js` cria as tabelas e o catalogo inicial sozinho no primeiro start — nao precisa rodar migracao manual.

## Publicacao

Guia completo (grátis, com dados persistentes) em **[DEPLOY.md](DEPLOY.md)**:

- **Render (Free)** roda o `server.js`.
- **Supabase (Free)** guarda o banco.
- Basta definir `DATABASE_URL` (Supabase) e as variaveis de ambiente no Render.

> O InfinityFree sozinho **nao** serve: ele nao executa Node.js, entao o admin/API/carrinho nao funcionam nele. Use Render + Supabase.
