# Donna Semijoias

E-commerce de semijoias em HTML/CSS/JavaScript com backend Node.js, Express, SQLite, login administrativo protegido e CRUD de produtos.

## Como executar

```bash
npm install
npm start
```

O servidor usa `http://localhost:3000` por padrao. Variaveis recomendadas:

```bash
$env:SESSION_SECRET="uma-chave-grande"
$env:ADMIN_EMAIL="admin@sualoja.com"
$env:ADMIN_PASSWORD="uma-senha-forte"
$env:STORE_WHATSAPP="5599999999999"
npm start
```

## Acesso administrativo

- Rota escondida: `/admin`
- Login: e-mail e senha configurados por variavel de ambiente.
- Credencial local inicial, se nenhuma variavel for definida: `admin@donna.local` / `DonnaAdmin2026!`
- Produtos: `/admin/produtos`
- Vendas: `/admin/vendas`

O link de admin nao aparece na loja publica. Quem acessa `/admin` sem sessao e redirecionado para `/login`.

## Funcionalidades

### Loja publica
- Vitrine carregada do SQLite com busca, filtro por categoria e ordenacao (destaques, preco, maiores descontos, nome).
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

## InfinityFree

O InfinityFree hospeda PHP/arquivos estaticos, mas nao executa backend Node.js persistente. Isso significa:

- `index.html`, CSS e imagens podem ser publicados como arquivos estaticos.
- O `.htaccess` incluido ajuda rotas diretas como `/login` e `/admin` a nao quebrarem.
- O CRUD do admin, login real, SQLite e APIs `/api/*` nao funcionam no InfinityFree puro, porque dependem do `server.js`.

Para publicar com admin funcional, use uma destas arquiteturas:

- Hospedar este backend Node em Render, Railway, Fly.io, VPS ou similar e apontar o frontend para ele.
- Migrar dados, imagens e autenticacao para Supabase. Para este tipo de loja, Supabase e a melhor opcao se a prioridade for admin online, imagens gerenciaveis e deploy estatico no InfinityFree.

## Supabase recomendado

Para producao com InfinityFree, crie no Supabase:

- Tabelas `products` e `categories`.
- Bucket publico para leitura de imagens.
- Auth para administradores.
- RLS permitindo leitura publica de produtos publicados.
- RLS permitindo criar/editar/excluir apenas para usuarios autenticados autorizados.

Sem as credenciais do projeto Supabase nao ha como configurar uma integracao real neste workspace, mas a estrutura atual ja separa as operacoes de produto de forma clara para essa migracao.
