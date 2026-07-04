const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const compression = require('compression');
const db = require('./db');
const importService = require('./lib/import/importService');

const app = express();
app.use(compression());
// Necessario atras de um proxy (Render/Railway) para o cookie de sessao "secure"
// ser reconhecido como HTTPS e o login do admin funcionar em producao.
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@donna.local').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'DonnaAdmin2026!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret-before-production';
const STORE_WHATSAPP = String(process.env.STORE_WHATSAPP || '').replace(/\D/g, '');

const q = (text, params) => db.query(text, params);

app.use(express.json({ limit: '24mb' }));
app.use(express.urlencoded({ extended: true, limit: '24mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));
// Sempre servir a versao mais recente: o navegador pode guardar o arquivo,
// mas SEMPRE revalida com o servidor (via ETag). Assim toda atualizacao
// publicada aparece na hora, sem ficar presa no cache do navegador.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(__dirname, {
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (filePath.match(/\.(png|jpg|jpeg|webp|gif|svg|css|js|html)$/i)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const DEFAULT_SITE_CONTENT = {
  hero_image: '/assets/editorial/hero-luxury-campaign.jpg',
  hero_eyebrow: 'Luxo acessível para todos os dias',
  hero_title: 'Semijoias que fazem o detalhe parecer assinatura.',
  hero_text: 'Curadoria de peças banhadas, versáteis e elegantes para presentear, combinar e usar com confiança do primeiro clique ao recebimento.',
  lookbook_image: '/assets/editorial/category-flatlay-premium.jpg',
  story_image: '/assets/products/produto6.jpg',
  gift_image: '/assets/products/produto8.jpg',
  showcase_all_image: '/assets/editorial/category-flatlay-premium.jpg'
};
const SITE_IMAGE_KEYS = ['hero_image', 'lookbook_image', 'story_image', 'gift_image', 'showcase_all_image'];
const SALE_STATUSES = ['Pago', 'Separacao', 'Enviado', 'Entregue', 'Cancelado'];

// ============================================================
// Schema + dados iniciais
// ============================================================
async function initDatabase() {
  await q(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    description TEXT NOT NULL,
    details TEXT,
    image TEXT NOT NULL,
    images TEXT,
    featured INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    stock INTEGER DEFAULT 0,
    sale_price DOUBLE PRECISION,
    promo INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ
  )`);

  await q(`CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    customer TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    subtitle TEXT,
    image TEXT,
    position INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
  await q('CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)');
  await q('CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_categories_position ON categories(position)');

  await seedProducts();
  await seedCatalogComplements();
  await seedCommerceShowcase();
  await seedCategories();
  await seedSales();
  await seedAdmin();
  // Atualiza produtos ja gravados: garantia de "6 meses" -> "1 ano" (roda uma vez).
  await runOnce('warranty-6m-to-1y-v1', async () => {
    await q("UPDATE products SET details = REPLACE(details, '6 meses', '1 ano') WHERE details LIKE '%6 meses%'");
  });
  // Modulo de Importacao de Catalogo: colunas novas (sku/custo/fornecedor),
  // indice unico de SKU e tabela de historico. Idempotente.
  await importService.ensureSchema();
}

// Executa uma acao uma unica vez, controlada por uma chave em store_meta.
async function runOnce(key, action) {
  const inserted = await q(
    'INSERT INTO store_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key',
    [key, new Date().toISOString()]
  );
  if (inserted.rows.length > 0) {
    await action();
  }
}

async function seedProducts() {
  const starter = [
    ['Brinco Aura Dourada', 'Brincos', 129.9, 'Banho dourado com acabamento polido e presenca delicada.', 'Hipoalergenico, banho 18k, tarraxa confortavel.', '/assets/products/produto1.jpg', 1],
    ['Colar Linha Fina', 'Colares', 189.9, 'Corrente minimalista para composicoes elegantes do dia a noite.', '45 cm com extensor, banho premium e garantia de 1 ano.', '/assets/products/produto2.jpg', 1],
    ['Anel Classic Glow', 'Anéis', 99.9, 'Peca clean com brilho sutil para usar sozinha ou em mix.', 'Numeracao ajustavel, zirconias cravejadas e polimento espelhado.', '/assets/products/produto3.jpg', 0],
    ['Pulseira Essenza', 'Pulseiras', 149.9, 'Pulseira leve com visual sofisticado para producao contemporanea.', 'Fecho lagosta, banho dourado e detalhe texturizado.', '/assets/products/produto4.jpg', 1]
  ];
  await insertSeedProducts(starter);
}

function seedCatalogComplements() {
  const products = [
    ['Piercing Celeste', 'Piercings', 79.9, 'Piercing delicado com brilho pontual para composicoes modernas.', 'Banho premium, encaixe confortavel e acabamento polido.', '/assets/products/produto5.jpg', 0],
    ['Tornozeleira Riviera', 'Tornozeleiras', 119.9, 'Tornozeleira fina com movimento suave e brilho elegante.', 'Corrente ajustavel, banho dourado e extensor delicado.', '/assets/products/produto6.jpg', 0],
    ['Conjunto Aurora', 'Conjuntos', 249.9, 'Colar e brincos coordenados para presentear com seguranca.', 'Kit presenteavel, banho 18k e embalagem Donna.', '/assets/products/produto7.jpg', 1],
    ['Brinco Lumiere', 'Lançamentos', 159.9, 'Lancamento com desenho luminoso e presenca sofisticada.', 'Hipoalergenico, tarraxa confortavel e garantia de 1 ano.', '/assets/products/produto8.jpg', 1],
    ['Colar Essencial Donna', 'Mais vendidos', 199.9, 'Mais vendido da colecao, perfeito para camadas minimalistas.', '45 cm com extensor, banho premium e polimento delicado.', '/assets/products/produto9.jpg', 1],
    ['Kit Presente Glow', 'Presentes', 299.9, 'Selecao pronta para surpreender em datas especiais.', 'Acompanha embalagem presenteavel e orientacoes de cuidado.', '/assets/products/produto10.jpg', 1],
    ['Anel Imperial', 'Coleção premium', 219.9, 'Anel de presenca com acabamento elegante para ocasioes especiais.', 'Zirconias cravejadas, banho nobre e acabamento espelhado.', '/assets/products/produto3.jpg', 1],
    ['Pulseira Oferta Donna', 'Promoções', 89.9, 'Peca selecionada com condicao especial por tempo limitado.', 'Fecho seguro, banho dourado e design versatil.', '/assets/products/produto4.jpg', 0]
  ];
  return insertSeedProducts(products);
}

// INSERT ... WHERE NOT EXISTS (por nome): idempotente e sem depender de ordem.
async function insertSeedProducts(list) {
  for (const p of list) {
    await q(
      `INSERT INTO products (name, category, price, description, details, image, images, featured, status)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'active'
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = $9)`,
      [p[0], p[1], p[2], p[3], p[4], p[5], JSON.stringify([p[5]]), p[6], p[0]]
    );
  }
}

// Da vida ao catalogo demo: estoque realista e algumas promocoes ativas.
async function seedCommerceShowcase() {
  await runOnce('commerce_showcase_v2', async () => {
    await q('UPDATE products SET stock = 12 WHERE stock IS NULL OR stock = 0');

    const stockByName = [
      ['Anel Classic Glow', 3],
      ['Piercing Celeste', 2],
      ['Tornozeleira Riviera', 0],
      ['Brinco Aura Dourada', 25],
      ['Conjunto Aurora', 8]
    ];
    for (const [name, stock] of stockByName) {
      await q('UPDATE products SET stock = $1 WHERE name = $2', [stock, name]);
    }

    const promos = [
      ['Pulseira Oferta Donna', 69.9],
      ['Colar Essencial Donna', 159.9],
      ['Kit Presente Glow', 249.9]
    ];
    for (const [name, salePrice] of promos) {
      await q('UPDATE products SET sale_price = $1, promo = 1 WHERE name = $2 AND price > $3', [salePrice, name, salePrice]);
    }
  });
}

async function seedCategories() {
  const flatlay = '/assets/editorial/category-flatlay-premium.jpg';
  const editorial = '/assets/editorial/hero-luxury-campaign.jpg';
  const starter = [
    ['Brincos', 'Luz perto do rosto', flatlay],
    ['Colares', 'Camadas delicadas', editorial],
    ['Anéis', 'Mix sofisticado', flatlay],
    ['Pulseiras', 'Detalhe de pulso', editorial],
    ['Conjuntos', 'Pronto para presentear', flatlay],
    ['Lançamentos', 'Novidades da semana', editorial],
    ['Mais vendidos', 'Escolhas queridinhas', flatlay],
    ['Promoções', 'Condições especiais', editorial],
    ['Coleção premium', 'Acabamento superior', flatlay],
    ['Presentes', 'Escolhas seguras', editorial]
  ];

  const total = Number((await q('SELECT COUNT(*)::int AS total FROM categories')).rows[0].total);
  if (total === 0) {
    for (let i = 0; i < starter.length; i++) {
      const c = starter[i];
      await q(
        'INSERT INTO categories (name, subtitle, image, position, active) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (name) DO NOTHING',
        [c[0], c[1], c[2], i]
      );
    }
  }

  // Garante que toda categoria usada em produtos tenha um registro (uma unica vez).
  await runOnce('categories_backfill_v1', async () => {
    const rows = (await q("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> ''")).rows;
    for (const row of rows) {
      await q(
        `INSERT INTO categories (name, subtitle, image, position, active)
         SELECT $1, '', '', (SELECT COALESCE(MAX(position), 0) + 1 FROM categories), 1
         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = $2)`,
        [row.category, row.category]
      );
    }
  });
}

async function seedSales() {
  const total = Number((await q('SELECT COUNT(*)::int AS total FROM sales')).rows[0].total);
  if (total > 0) return;

  const starter = [
    [1, 'Marina Alves', 2, 259.8, 'Pago'],
    [2, 'Bianca Rocha', 1, 189.9, 'Separacao'],
    [4, 'Clara Mendes', 3, 449.7, 'Enviado']
  ];
  for (const s of starter) {
    await q('INSERT INTO sales (product_id, customer, quantity, total, status) VALUES ($1, $2, $3, $4, $5)', s);
  }
}

async function seedAdmin() {
  const existing = await q('SELECT id FROM admins WHERE email = $1', [ADMIN_EMAIL]);
  if (existing.rows.length) return;
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await q(
    'INSERT INTO admins (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [ADMIN_EMAIL, passwordHash]
  );
  console.log(`Admin criado: ${ADMIN_EMAIL}`);
}

// ============================================================
// Helpers de serializacao / validacao
// ============================================================
function parseImages(value, fallback = '') {
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch (error) {
    // Compatibilidade com registros antigos.
  }
  return fallback ? [fallback] : [];
}

function serializeProduct(row) {
  if (!row) return row;
  const images = parseImages(row.images, row.image);
  return {
    ...row,
    image: images[0] || row.image,
    images,
    price: Number(row.price || 0),
    featured: Number(row.featured || 0),
    stock: Number(row.stock || 0),
    promo: Number(row.promo || 0),
    sale_price: row.sale_price === null || row.sale_price === undefined ? null : Number(row.sale_price)
  };
}

function normalizeProductPayload(body) {
  const normalizedPrice = Number(body.price);
  const normalizedSalePrice = body.sale_price ? Number(body.sale_price) : null;
  const images = Array.isArray(body.images)
    ? body.images.map((image) => String(image || '').trim()).filter(Boolean)
    : [body.image, body.imageUrl].map((image) => String(image || '').trim()).filter(Boolean);

  return {
    name: String(body.name || '').trim(),
    category: String(body.category || '').trim(),
    price: normalizedPrice,
    description: String(body.description || '').trim(),
    details: body.details ? String(body.details).trim() : '',
    images,
    featured: body.featured ? 1 : 0,
    status: body.status === 'draft' ? 'draft' : 'active',
    stock: Number.isFinite(Number(body.stock)) ? Number(body.stock) : 0,
    promo: body.promo ? 1 : 0,
    sale_price: Number.isFinite(normalizedSalePrice) && normalizedSalePrice > 0 ? normalizedSalePrice : null
  };
}

function validateProduct(product) {
  if (!product.name || !product.category || !Number.isFinite(product.price) || product.price <= 0 || !product.description) {
    return 'Preencha nome, categoria, preco e descricao.';
  }
  if (!product.images.length) {
    return 'Adicione pelo menos uma imagem principal.';
  }
  return '';
}

function serializeCategory(row) {
  const serialized = {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle || '',
    image: row.image || '',
    position: Number(row.position || 0),
    active: Number(row.active || 0)
  };
  if (row.product_count !== undefined) {
    serialized.product_count = Number(row.product_count);
  }
  return serialized;
}

function normalizeCategoryPayload(body) {
  return {
    name: String(body.name || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    image: String(body.image || '').trim(),
    active: body.active === false || body.active === 'false' || body.active === 0 || body.active === '0' ? 0 : 1,
    position: Number.isFinite(Number(body.position)) && body.position !== '' && body.position !== null && body.position !== undefined
      ? Number(body.position)
      : null
  };
}

async function getSiteContent() {
  const res = await q('SELECT value FROM store_meta WHERE key = $1', ['site_content']);
  if (!res.rows.length) return { ...DEFAULT_SITE_CONTENT };
  let stored = {};
  try {
    stored = JSON.parse(res.rows[0].value) || {};
  } catch (error) {
    stored = {};
  }
  return { ...DEFAULT_SITE_CONTENT, ...stored };
}

function requireAdmin(req, res, next) {
  if (req.session.adminId) {
    return next();
  }
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Acesso restrito ao administrador.' });
  }
  return res.redirect('/login');
}

// ============================================================
// Rotas de paginas
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin/produtos');
  return res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.adminId), email: req.session.adminEmail || null });
});

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }

  try {
    const admin = (await q('SELECT id, email, password_hash FROM admins WHERE lower(email) = $1', [email])).rows[0];
    if (!admin) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    req.session.regenerate((sessionErr) => {
      if (sessionErr) {
        return res.status(500).json({ error: 'Erro ao criar sessao administrativa.' });
      }
      req.session.adminId = admin.id;
      req.session.adminEmail = admin.email;
      res.json({ success: true, redirect: '/admin/produtos' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao autenticar.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/produtos'));
app.get('/admin/produtos', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/admin/vendas', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'sales.html')));
app.get('/admin/conteudo', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'content.html')));
app.get('/admin/importar', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'import.html')));
app.get('/dashboard', requireAdmin, (req, res) => res.redirect('/admin/produtos'));

app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));

app.post('/register', async (req, res) => {
  const { name, cpf, phone } = req.body;
  const normalizedCpf = String(cpf || '').replace(/\D/g, '');
  const normalizedPhone = String(phone || '').replace(/\D/g, '');

  if (!name || normalizedCpf.length !== 11 || normalizedPhone.length < 10) {
    return res.status(400).json({ error: 'Preencha nome, CPF com 11 digitos e telefone valido.' });
  }

  try {
    const result = await q(
      'INSERT INTO customers (name, cpf, phone) VALUES ($1, $2, $3) RETURNING id',
      [String(name).trim(), normalizedCpf, normalizedPhone]
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'CPF ja cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao cadastrar.' });
  }
});

app.get('/api/store-config', (req, res) => res.json({ whatsapp: STORE_WHATSAPP }));

// ============================================================
// Produtos
// ============================================================
app.get('/api/products', async (req, res) => {
  const { category, search, sort, includeDrafts } = req.query;
  const where = [];
  const params = [];
  let orderBy = 'featured DESC, created_at DESC, id DESC';

  if (!req.session.adminId || includeDrafts !== '1') {
    where.push("(status IS NULL OR status = 'active')");
  }
  if (category && category !== 'Todos') {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(name ILIKE ${p} OR category ILIKE ${p} OR description ILIKE ${p} OR details ILIKE ${p})`);
  }
  if (sort === 'price-asc') orderBy = 'price ASC, lower(name) ASC';
  if (sort === 'price-desc') orderBy = 'price DESC, lower(name) ASC';
  if (sort === 'name') orderBy = 'lower(name) ASC';

  const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`;

  try {
    const result = await q(sql, params);
    res.json(result.rows.map(serializeProduct));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

app.get('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const row = (await q('SELECT * FROM products WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!row) return res.status(404).json({ error: 'Produto nao encontrado.' });
    res.json(serializeProduct(row));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produto.' });
  }
});

app.get('/produtos', (req, res) => res.redirect('/api/products'));

app.post('/api/products', requireAdmin, async (req, res) => {
  const product = normalizeProductPayload(req.body);
  const error = validateProduct(product);
  if (error) return res.status(400).json({ error });

  try {
    const result = await q(
      `INSERT INTO products
        (name, category, price, description, details, image, images, featured, status, stock, sale_price, promo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       RETURNING id`,
      [
        product.name, product.category, product.price, product.description, product.details,
        product.images[0], JSON.stringify(product.images), product.featured, product.status,
        product.stock, product.sale_price, product.promo
      ]
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cadastrar produto.' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const product = normalizeProductPayload(req.body);
  const error = validateProduct(product);
  if (error) return res.status(400).json({ error });

  try {
    const result = await q(
      `UPDATE products
       SET name = $1, category = $2, price = $3, description = $4, details = $5, image = $6, images = $7,
           featured = $8, status = $9, stock = $10, sale_price = $11, promo = $12, updated_at = now()
       WHERE id = $13`,
      [
        product.name, product.category, product.price, product.description, product.details,
        product.images[0], JSON.stringify(product.images), product.featured, product.status,
        product.stock, product.sale_price, product.promo, Number(req.params.id)
      ]
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar produto.' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const result = await q('DELETE FROM products WHERE id = $1', [Number(req.params.id)]);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover produto.' });
  }
});

// ============================================================
// Importacao de Catalogo
// (upload -> preview -> commit em segundo plano -> logs)
// ============================================================

// Recebe o arquivo em base64 (JSON), analisa e devolve o preview sem gravar.
app.post('/api/import/preview', requireAdmin, async (req, res) => {
  const filename = String(req.body.filename || 'catalogo').trim();
  const data = String(req.body.data || '');
  if (!data) return res.status(400).json({ error: 'Envie um arquivo XLSX, XLS ou CSV.' });

  let buffer;
  try {
    // Aceita "data:...;base64,XXXX" ou o base64 puro.
    const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Arquivo invalido.' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio.' });
  if (buffer.length > 25 * 1024 * 1024) {
    return res.status(413).json({ error: 'Arquivo muito grande (limite de 25 MB).' });
  }

  try {
    const preview = await importService.preparePreview(buffer, filename, req.session.adminEmail || '');
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Nao foi possivel ler o arquivo.' });
  }
});

// Confirma a importacao: grava em lote, em segundo plano.
app.post('/api/import/commit', requireAdmin, (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  const deactivateMissing = req.body.deactivateMissing === true || req.body.deactivateMissing === 'true';
  if (!uploadId) return res.status(400).json({ error: 'Sessao de importacao invalida.' });
  try {
    const jobId = importService.startCommit(uploadId, { deactivateMissing }, req.session.adminEmail || '');
    res.json({ success: true, jobId });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Nao foi possivel iniciar a importacao.' });
  }
});

// Progresso da importacao (o painel consulta em intervalos).
app.get('/api/import/jobs/:id', requireAdmin, (req, res) => {
  const job = importService.getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Importacao nao encontrada.' });
  res.json(job);
});

// Historico das importacoes.
app.get('/api/import/logs', requireAdmin, async (req, res) => {
  try {
    res.json(await importService.listLogs(50));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar historico.' });
  }
});

// Baixa o CSV de erros de uma importacao.
app.get('/api/import/logs/:id/errors.csv', requireAdmin, async (req, res) => {
  try {
    const data = await importService.getLogErrors(req.params.id);
    if (!data) return res.status(404).send('Importacao nao encontrada.');
    const csv = importService.errorsToCsv(data.errors || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="erros-importacao-${Number(req.params.id)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send('Erro ao gerar o relatorio.');
  }
});

// ============================================================
// Categorias
// ============================================================
app.get('/api/categories', async (req, res) => {
  const includeInactive = Boolean(req.session.adminId) && req.query.admin === '1';

  try {
    let rows;
    if (includeInactive) {
      rows = (await q(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count
         FROM categories c
         ORDER BY c.position ASC, lower(c.name) ASC`
      )).rows;
    } else {
      rows = (await q('SELECT * FROM categories WHERE active = 1 ORDER BY position ASC, lower(name) ASC')).rows;
    }

    if (!rows.length && !includeInactive) {
      const total = Number((await q('SELECT COUNT(*)::int AS total FROM categories')).rows[0].total);
      if (total > 0) return res.json([]);
      const fallback = (await q("SELECT DISTINCT category AS name FROM products WHERE status IS NULL OR status = 'active' ORDER BY category")).rows;
      return res.json(fallback.map((row, index) => ({ id: null, name: row.name, subtitle: '', image: '', position: index, active: 1 })));
    }

    res.json(rows.map(serializeCategory));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar categorias.' });
  }
});

app.post('/api/categories', requireAdmin, async (req, res) => {
  const category = normalizeCategoryPayload(req.body);
  if (!category.name) return res.status(400).json({ error: 'Informe o nome da categoria.' });

  try {
    let position = category.position;
    if (position === null) {
      position = Number((await q('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories')).rows[0].next);
    }
    const result = await q(
      'INSERT INTO categories (name, subtitle, image, position, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [category.name, category.subtitle, category.image, position, category.active]
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    res.status(500).json({ error: 'Erro ao criar categoria.' });
  }
});

app.put('/api/categories/:id', requireAdmin, async (req, res) => {
  const category = normalizeCategoryPayload(req.body);
  if (!category.name) return res.status(400).json({ error: 'Informe o nome da categoria.' });
  const renameProducts = req.body.renameProducts === true || req.body.renameProducts === 'true';

  try {
    const existing = (await q('SELECT * FROM categories WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Categoria não encontrada.' });

    const position = category.position === null ? existing.position : category.position;
    const result = await q(
      'UPDATE categories SET name = $1, subtitle = $2, image = $3, position = $4, active = $5 WHERE id = $6',
      [category.name, category.subtitle, category.image, position, category.active, Number(req.params.id)]
    );

    if (renameProducts && existing.name !== category.name) {
      await q('UPDATE products SET category = $1 WHERE category = $2', [category.name, existing.name]);
      return res.json({ success: true, updated: result.rowCount, renamed: true });
    }
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    res.status(500).json({ error: 'Erro ao atualizar categoria.' });
  }
});

app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const result = await q('DELETE FROM categories WHERE id = $1', [Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover categoria.' });
  }
});

// ============================================================
// Conteudo do site (banners + textos)
// ============================================================
app.get('/api/site-content', async (req, res) => {
  try {
    res.json(await getSiteContent());
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar conteúdo do site.' });
  }
});

app.put('/api/site-content', requireAdmin, async (req, res) => {
  try {
    const current = await getSiteContent();
    const next = { ...current };
    for (const key of Object.keys(DEFAULT_SITE_CONTENT)) {
      if (req.body[key] === undefined || req.body[key] === null) continue;
      const value = String(req.body[key]);
      if (SITE_IMAGE_KEYS.includes(key) && value.trim() === '') {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    await q(
      'INSERT INTO store_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['site_content', JSON.stringify(next)]
    );
    res.json({ success: true, content: { ...DEFAULT_SITE_CONTENT, ...next } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar conteúdo do site.' });
  }
});

// ============================================================
// Vendas
// ============================================================
app.get('/api/sales', requireAdmin, async (req, res) => {
  try {
    const rows = (await q(
      `SELECT sales.id, sales.product_id, sales.customer, sales.quantity, sales.total, sales.status,
              to_char(sales.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              products.name AS product_name
       FROM sales
       LEFT JOIN products ON products.id = sales.product_id
       ORDER BY sales.created_at DESC`
    )).rows;
    res.json(rows.map((row) => ({ ...row, total: Number(row.total || 0), quantity: Number(row.quantity || 0) })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar vendas.' });
  }
});

app.post('/api/sales', requireAdmin, async (req, res) => {
  const productId = Number(req.body.product_id);
  const customer = String(req.body.customer || '').trim();
  const quantity = Math.max(1, Math.round(Number(req.body.quantity) || 0));
  const requestedStatus = String(req.body.status || 'Pago').trim();
  const status = SALE_STATUSES.includes(requestedStatus) ? requestedStatus : 'Pago';
  const reduceStock = req.body.reduce_stock !== false && req.body.reduce_stock !== 'false';

  if (!customer || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Informe o cliente e uma quantidade valida.' });
  }
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: 'Selecione um produto valido.' });
  }

  try {
    const product = (await q('SELECT * FROM products WHERE id = $1', [productId])).rows[0];
    if (!product) return res.status(400).json({ error: 'Selecione um produto valido.' });

    const unitPrice = Number(product.sale_price) > 0 ? Number(product.sale_price) : Number(product.price);
    const providedTotal = Number(req.body.total);
    const total = Number.isFinite(providedTotal) && providedTotal > 0 ? providedTotal : unitPrice * quantity;

    const result = await q(
      'INSERT INTO sales (product_id, customer, quantity, total, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [product.id, customer, quantity, total, status]
    );

    if (reduceStock) {
      await q('UPDATE products SET stock = GREATEST(0, COALESCE(stock, 0) - $1) WHERE id = $2', [quantity, product.id]);
    }

    res.status(201).json({ success: true, id: result.rows[0].id, total });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar a venda.' });
  }
});

app.patch('/api/sales/:id', requireAdmin, async (req, res) => {
  const requestedStatus = String(req.body.status || '').trim();
  if (!SALE_STATUSES.includes(requestedStatus)) {
    return res.status(400).json({ error: 'Status invalido.' });
  }
  try {
    const result = await q('UPDATE sales SET status = $1 WHERE id = $2', [requestedStatus, Number(req.params.id)]);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar a venda.' });
  }
});

app.delete('/api/sales/:id', requireAdmin, async (req, res) => {
  try {
    const result = await q('DELETE FROM sales WHERE id = $1', [Number(req.params.id)]);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover a venda.' });
  }
});

app.get('/api/customers', requireAdmin, async (req, res) => {
  try {
    const rows = (await q(
      "SELECT id, name, cpf, phone, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at FROM customers ORDER BY created_at DESC"
    )).rows;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
});

app.post('/contato', (req, res) => {
  const { nome, email, mensagem } = req.body;
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
  if (!nome || !validEmail || !mensagem || String(mensagem).trim().length < 8) {
    return res.status(400).json({ error: 'Preencha nome, email valido e uma mensagem com detalhes.' });
  }
  console.log('Mensagem recebida:', {
    nome: String(nome).trim(),
    email: String(email).trim(),
    mensagem: String(mensagem).trim()
  });
  res.json({ sucesso: true, mensagem: 'Mensagem enviada com sucesso.' });
});

// ============================================================
// Inicializacao
// ============================================================
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
      console.log(`Admin: ${ADMIN_EMAIL}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log(`Senha admin inicial: ${ADMIN_PASSWORD}`);
      }
    });
  })
  .catch((err) => {
    console.error('Falha ao inicializar o banco de dados:', err.message);
    process.exit(1);
  });
