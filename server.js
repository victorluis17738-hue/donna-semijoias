const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const compression = require('compression');

const app = express();
app.use(compression());
// Necessario atras de um proxy (Render/Railway/etc.) para que o cookie de sessao
// "secure" seja reconhecido como HTTPS e o login do admin funcione em producao.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@donna.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'DonnaAdmin2026!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret-before-production';
const STORE_WHATSAPP = String(process.env.STORE_WHATSAPP || '').replace(/\D/g, '');
// Caminho do banco configuravel para apontar a um disco persistente na hospedagem
// (ex.: DATABASE_PATH=/data/database.db no Render). Sem isso o SQLite fica na pasta
// do app e e apagado a cada deploy.
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Erro ao conectar ao SQLite:', err.message);
    return;
  }

  console.log(`Banco SQLite conectado: ${DB_PATH}`);
});

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
app.use(express.static(__dirname, {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.match(/\.(png|jpg|jpeg|webp|gif|svg|css|js)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT NOT NULL,
    details TEXT,
    image TEXT NOT NULL,
    featured INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    customer TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    subtitle TEXT,
    image TEXT,
    position INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  ensureProductSchema(() => {
    // Indices criados so DEPOIS do schema estar completo: a coluna `status` e
    // adicionada por ALTER TABLE dentro de ensureProductSchema, entao um indice
    // sobre products(status) precisa esperar por ela.
    db.run('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_categories_position ON categories(position)');

    seedProducts();
    seedCatalogComplements();
    migrateProductImages();
    seedCommerceShowcase();
    seedCategories();
    seedSales();
  });
  seedAdmin();
});

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

function getSiteContent(callback) {
  db.get('SELECT value FROM store_meta WHERE key = ?', ['site_content'], (err, row) => {
    if (err || !row) {
      callback({ ...DEFAULT_SITE_CONTENT });
      return;
    }
    let stored = {};
    try {
      stored = JSON.parse(row.value) || {};
    } catch (parseError) {
      stored = {};
    }
    callback({ ...DEFAULT_SITE_CONTENT, ...stored });
  });
}

// Executa uma acao apenas uma vez, controlando por uma chave em store_meta.
function runOnce(key, action) {
  db.get('SELECT value FROM store_meta WHERE key = ?', [key], (err, row) => {
    if (err || row) return;
    db.run('INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)', [key, new Date().toISOString()], (insertErr) => {
      if (insertErr) return;
      action();
    });
  });
}

function ensureProductSchema(done) {
  const columns = [
    ['images', 'TEXT'],
    ['status', "TEXT DEFAULT 'active'"],
    ['stock', 'INTEGER DEFAULT 0'],
    ['sale_price', 'REAL'],
    ['promo', 'INTEGER DEFAULT 0'],
    ['updated_at', 'TEXT']
  ];

  db.all('PRAGMA table_info(products)', (err, rows) => {
    if (err) {
      console.error('Erro ao ler estrutura de produtos:', err.message);
      done();
      return;
    }

    const existing = new Set(rows.map((row) => row.name));
    const missing = columns.filter(([name]) => !existing.has(name));

    if (!missing.length) {
      done();
      return;
    }

    let pending = missing.length;
    missing.forEach(([name, definition]) => {
      db.run(`ALTER TABLE products ADD COLUMN ${name} ${definition}`, (alterErr) => {
        if (alterErr) console.error(`Erro ao adicionar coluna ${name}:`, alterErr.message);
        pending -= 1;
        if (!pending) done();
      });
    });
  });
}

function seedAdmin() {
  db.get('SELECT id FROM admins WHERE email = ?', [ADMIN_EMAIL], async (err, row) => {
    if (err || row) return;

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    db.run('INSERT INTO admins (email, password_hash) VALUES (?, ?)', [ADMIN_EMAIL, passwordHash], (insertErr) => {
      if (insertErr) {
        console.error('Erro ao criar administrador:', insertErr.message);
        return;
      }

      console.log(`Admin criado: ${ADMIN_EMAIL}`);
    });
  });
}

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
    featured: Number(row.featured || 0),
    stock: Number(row.stock || 0),
    promo: Number(row.promo || 0),
    sale_price: row.sale_price === null || row.sale_price === undefined ? null : Number(row.sale_price)
  };
}

function migrateProductImages() {
  db.all('SELECT id, image, images FROM products', (err, rows) => {
    if (err) return;

    rows
      .filter((row) => !parseImages(row.images, row.image).length && row.image)
      .forEach((row) => {
        db.run('UPDATE products SET images = ? WHERE id = ?', [JSON.stringify([row.image]), row.id]);
      });
  });
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

function requireAdmin(req, res, next) {
  if (req.session.adminId) {
    return next();
  }

  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Acesso restrito ao administrador.' });
  }

  return res.redirect('/login');
}

function seedProducts() {
  const starterProducts = [
    ['Brinco Aura Dourada', 'Brincos', 129.9, 'Banho dourado com acabamento polido e presenca delicada.', 'Hipoalergenico, banho 18k, tarraxa confortavel.', '/assets/products/produto1.jpg', 1],
    ['Colar Linha Fina', 'Colares', 189.9, 'Corrente minimalista para composicoes elegantes do dia a noite.', '45 cm com extensor, banho premium e garantia de 6 meses.', '/assets/products/produto2.jpg', 1],
    ['Anel Classic Glow', 'Anéis', 99.9, 'Peca clean com brilho sutil para usar sozinha ou em mix.', 'Numeracao ajustavel, zirconias cravejadas e polimento espelhado.', '/assets/products/produto3.jpg', 0],
    ['Pulseira Essenza', 'Pulseiras', 149.9, 'Pulseira leve com visual sofisticado para producao contemporanea.', 'Fecho lagosta, banho dourado e detalhe texturizado.', '/assets/products/produto4.jpg', 1]
  ];

  // INSERT ... WHERE NOT EXISTS (por nome) para ser idempotente e nao depender
  // da ordem de execucao em relacao a seedCatalogComplements (evita corrida que
  // deixava as 4 pecas iniciais de fora numa instalacao limpa).
  const stmt = db.prepare(`INSERT INTO products
    (name, category, price, description, details, image, images, featured, status)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)`);

  starterProducts.forEach((product) => stmt.run([...product.slice(0, 6), JSON.stringify([product[5]]), product[6], product[0]]));
  stmt.finalize();
}

function seedCatalogComplements() {
  const products = [
    ['Piercing Celeste', 'Piercings', 79.9, 'Piercing delicado com brilho pontual para composicoes modernas.', 'Banho premium, encaixe confortavel e acabamento polido.', '/assets/products/produto5.jpg', 0],
    ['Tornozeleira Riviera', 'Tornozeleiras', 119.9, 'Tornozeleira fina com movimento suave e brilho elegante.', 'Corrente ajustavel, banho dourado e extensor delicado.', '/assets/products/produto6.jpg', 0],
    ['Conjunto Aurora', 'Conjuntos', 249.9, 'Colar e brincos coordenados para presentear com seguranca.', 'Kit presenteavel, banho 18k e embalagem Donna.', '/assets/products/produto7.jpg', 1],
    ['Brinco Lumiere', 'Lançamentos', 159.9, 'Lancamento com desenho luminoso e presenca sofisticada.', 'Hipoalergenico, tarraxa confortavel e garantia de 6 meses.', '/assets/products/produto8.jpg', 1],
    ['Colar Essencial Donna', 'Mais vendidos', 199.9, 'Mais vendido da colecao, perfeito para camadas minimalistas.', '45 cm com extensor, banho premium e polimento delicado.', '/assets/products/produto9.jpg', 1],
    ['Kit Presente Glow', 'Presentes', 299.9, 'Selecao pronta para surpreender em datas especiais.', 'Acompanha embalagem presenteavel e orientacoes de cuidado.', '/assets/products/produto10.jpg', 1],
    ['Anel Imperial', 'Coleção premium', 219.9, 'Anel de presenca com acabamento elegante para ocasioes especiais.', 'Zirconias cravejadas, banho nobre e acabamento espelhado.', '/assets/products/produto3.jpg', 1],
    ['Pulseira Oferta Donna', 'Promoções', 89.9, 'Peca selecionada com condicao especial por tempo limitado.', 'Fecho seguro, banho dourado e design versatil.', '/assets/products/produto4.jpg', 0]
  ];

  const stmt = db.prepare(`INSERT INTO products
    (name, category, price, description, details, image, images, featured, status)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)`);

  products.forEach((product) => stmt.run([...product.slice(0, 6), JSON.stringify([product[5]]), product[6], product[0]]));
  stmt.finalize();
}

// Da vida ao catalogo demo: estoque realista e algumas promocoes ativas,
// para que os recursos de venda (preco promocional, esgotado, ultimas unidades)
// aparecam na vitrine. Roda uma unica vez por instalacao.
function seedCommerceShowcase() {
  runOnce('commerce_showcase_v2', () => {
    // db.serialize garante a ordem: o preenchimento padrao roda primeiro e os
    // valores especificos (inclusive o estoque zerado) sobrescrevem por ultimo.
    db.serialize(() => {
      // Estoque padrao apenas para pecas que ainda nao tinham controle definido.
      db.run("UPDATE products SET stock = 12 WHERE stock IS NULL OR stock = 0");

      // Variacao de estoque para demonstrar os estados da vitrine.
      const stockByName = [
        ['Anel Classic Glow', 3],       // ultimas unidades
        ['Piercing Celeste', 2],        // ultimas unidades
        ['Tornozeleira Riviera', 0],    // esgotado
        ['Brinco Aura Dourada', 25],
        ['Conjunto Aurora', 8]
      ];
      stockByName.forEach(([name, stock]) => {
        db.run('UPDATE products SET stock = ? WHERE name = ?', [stock, name]);
      });

      // Promocoes ativas com preco promocional e flag de destaque de oferta.
      const promos = [
        ['Pulseira Oferta Donna', 69.9],
        ['Colar Essencial Donna', 159.9],
        ['Kit Presente Glow', 249.9]
      ];
      promos.forEach(([name, salePrice]) => {
        db.run('UPDATE products SET sale_price = ?, promo = 1 WHERE name = ? AND price > ?', [salePrice, name, salePrice]);
      });
    });
  });
}

function seedCategories() {
  db.get('SELECT COUNT(*) AS total FROM categories', (err, row) => {
    if (err) return;

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

    const insertStarter = (done) => {
      if (row.total > 0) {
        done();
        return;
      }
      const stmt = db.prepare('INSERT OR IGNORE INTO categories (name, subtitle, image, position, active) VALUES (?, ?, ?, ?, 1)');
      starter.forEach((category, index) => stmt.run([category[0], category[1], category[2], index]));
      stmt.finalize(done);
    };

    // Garante que toda categoria usada em produtos tenha um registro (uma unica vez).
    insertStarter(() => {
      runOnce('categories_backfill_v1', () => {
        db.all('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""', (listErr, rows) => {
          if (listErr) return;
          rows.forEach((productRow) => {
            db.run(
              `INSERT OR IGNORE INTO categories (name, subtitle, image, position, active)
               SELECT ?, '', '', (SELECT COALESCE(MAX(position), 0) + 1 FROM categories), 1
               WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = ?)`,
              [productRow.category, productRow.category]
            );
          });
        });
      });
    });
  });
}

function seedSales() {
  db.get('SELECT COUNT(*) AS total FROM sales', (err, row) => {
    if (err || row.total > 0) return;

    const starterSales = [
      [1, 'Marina Alves', 2, 259.8, 'Pago'],
      [2, 'Bianca Rocha', 1, 189.9, 'Separacao'],
      [4, 'Clara Mendes', 3, 449.7, 'Enviado']
    ];

    const stmt = db.prepare(`INSERT INTO sales
      (product_id, customer, quantity, total, status)
      VALUES (?, ?, ?, ?, ?)`);

    starterSales.forEach((sale) => stmt.run(sale));
    stmt.finalize();
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.session.adminId) {
    return res.redirect('/admin/produtos');
  }

  return res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session.adminId),
    email: req.session.adminEmail || null
  });
});

app.post('/login', (req, res) => {
  const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }

  db.get('SELECT id, email, password_hash FROM admins WHERE lower(email) = ?', [normalizedEmail], async (err, admin) => {
    if (err || !admin) {
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
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.redirect('/admin/produtos');
});

app.get('/admin/produtos', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/admin/vendas', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'sales.html'));
});

app.get('/admin/conteudo', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'content.html'));
});

app.get('/dashboard', requireAdmin, (req, res) => {
  res.redirect('/admin/produtos');
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'register.html'));
});

app.post('/register', (req, res) => {
  const { name, cpf, phone } = req.body;
  const normalizedCpf = String(cpf || '').replace(/\D/g, '');
  const normalizedPhone = String(phone || '').replace(/\D/g, '');

  if (!name || normalizedCpf.length !== 11 || normalizedPhone.length < 10) {
    return res.status(400).json({
      error: 'Preencha nome, CPF com 11 digitos e telefone valido.'
    });
  }

  db.run(
    'INSERT INTO customers (name, cpf, phone) VALUES (?, ?, ?)',
    [name.trim(), normalizedCpf, normalizedPhone],
    function onInsert(err) {
      if (err) {
        return res.status(400).json({ error: 'CPF ja cadastrado.' });
      }

      res.status(201).json({ success: true, id: this.lastID });
    }
  );
});

app.get('/api/store-config', (req, res) => {
  res.json({ whatsapp: STORE_WHATSAPP });
});

app.get('/api/products', (req, res) => {
  const { category, search, sort, includeDrafts } = req.query;
  const params = [];
  const where = [];
  let orderBy = 'featured DESC, created_at DESC, id DESC';

  if (!req.session.adminId || includeDrafts !== '1') {
    where.push("(status IS NULL OR status = 'active')");
  }

  if (category && category !== 'Todos') {
    where.push('category = ?');
    params.push(category);
  }

  if (search) {
    const term = `%${search}%`;
    where.push('(name LIKE ? OR category LIKE ? OR description LIKE ? OR details LIKE ?)');
    params.push(term, term, term, term);
  }

  if (sort === 'price-asc') orderBy = 'price ASC, name ASC';
  if (sort === 'price-desc') orderBy = 'price DESC, name ASC';
  if (sort === 'name') orderBy = 'name COLLATE NOCASE ASC';

  const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar produtos.' });
    }

    res.json(rows.map(serializeProduct));
  });
});

app.get('/api/products/:id', requireAdmin, (req, res) => {
  db.get('SELECT * FROM products WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar produto.' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Produto nao encontrado.' });
    }

    res.json(serializeProduct(row));
  });
});

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

app.get('/api/categories', (req, res) => {
  const includeInactive = Boolean(req.session.adminId) && req.query.admin === '1';

  const sql = includeInactive
    ? `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count
       FROM categories c
       ORDER BY c.position ASC, c.name COLLATE NOCASE ASC`
    : 'SELECT * FROM categories WHERE active = 1 ORDER BY position ASC, name COLLATE NOCASE ASC';

  db.all(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar categorias.' });
    }

    if (!rows.length && !includeInactive) {
      // So usa o fallback derivado de produtos se a tabela de categorias
      // estiver realmente vazia (nao quando todas foram desativadas de proposito).
      db.get('SELECT COUNT(*) AS total FROM categories', (countErr, countRow) => {
        if (!countErr && countRow && countRow.total > 0) {
          return res.json([]);
        }
        db.all("SELECT DISTINCT category AS name FROM products WHERE status IS NULL OR status = 'active' ORDER BY name COLLATE NOCASE ASC", (fallbackErr, fallbackRows) => {
          if (fallbackErr) {
            return res.status(500).json({ error: 'Erro ao buscar categorias.' });
          }
          res.json(fallbackRows.map((row, index) => ({ id: null, name: row.name, subtitle: '', image: '', position: index, active: 1 })));
        });
      });
      return;
    }

    res.json(rows.map(serializeCategory));
  });
});

app.post('/api/categories', requireAdmin, (req, res) => {
  const category = normalizeCategoryPayload(req.body);
  if (!category.name) {
    return res.status(400).json({ error: 'Informe o nome da categoria.' });
  }

  const insert = (position) => {
    db.run(
      'INSERT INTO categories (name, subtitle, image, position, active) VALUES (?, ?, ?, ?, ?)',
      [category.name, category.subtitle, category.image, position, category.active],
      function onInsert(err) {
        if (err) {
          if (String(err.message).includes('UNIQUE')) {
            return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
          }
          return res.status(500).json({ error: 'Erro ao criar categoria.' });
        }
        res.status(201).json({ success: true, id: this.lastID });
      }
    );
  };

  if (category.position === null) {
    db.get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM categories', (err, row) => insert(err ? 0 : row.next));
  } else {
    insert(category.position);
  }
});

app.put('/api/categories/:id', requireAdmin, (req, res) => {
  const category = normalizeCategoryPayload(req.body);
  if (!category.name) {
    return res.status(400).json({ error: 'Informe o nome da categoria.' });
  }
  const renameProducts = req.body.renameProducts === true || req.body.renameProducts === 'true';

  db.get('SELECT * FROM categories WHERE id = ?', [req.params.id], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao atualizar categoria.' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Categoria não encontrada.' });
    }

    const position = category.position === null ? existing.position : category.position;
    db.run(
      'UPDATE categories SET name = ?, subtitle = ?, image = ?, position = ?, active = ? WHERE id = ?',
      [category.name, category.subtitle, category.image, position, category.active, req.params.id],
      function onUpdate(updateErr) {
        if (updateErr) {
          if (String(updateErr.message).includes('UNIQUE')) {
            return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
          }
          return res.status(500).json({ error: 'Erro ao atualizar categoria.' });
        }

        const updated = this.changes;
        if (renameProducts && existing.name !== category.name) {
          db.run('UPDATE products SET category = ? WHERE category = ?', [category.name, existing.name], (renameErr) => {
            res.json({ success: true, updated, renamed: !renameErr });
          });
          return;
        }
        res.json({ success: true, updated });
      }
    );
  });
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  db.get('SELECT * FROM categories WHERE id = ?', [req.params.id], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao remover categoria.' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Categoria não encontrada.' });
    }

    db.run('DELETE FROM categories WHERE id = ?', [req.params.id], function onDelete(delErr) {
      if (delErr) {
        return res.status(500).json({ error: 'Erro ao remover categoria.' });
      }
      res.json({ success: true, deleted: this.changes });
    });
  });
});

app.get('/api/site-content', (req, res) => {
  getSiteContent((content) => res.json(content));
});

const SITE_IMAGE_KEYS = ['hero_image', 'lookbook_image', 'story_image', 'gift_image', 'showcase_all_image'];

app.put('/api/site-content', requireAdmin, (req, res) => {
  getSiteContent((current) => {
    const next = { ...current };
    Object.keys(DEFAULT_SITE_CONTENT).forEach((key) => {
      if (req.body[key] === undefined || req.body[key] === null) return;
      const value = String(req.body[key]);
      // Imagem vazia = "restaurar padrao": remove o override para o default voltar.
      if (SITE_IMAGE_KEYS.includes(key) && value.trim() === '') {
        delete next[key];
      } else {
        next[key] = value;
      }
    });

    db.run(
      'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
      ['site_content', JSON.stringify(next)],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao salvar conteúdo do site.' });
        }
        // Retorna com os defaults mesclados para a previa do admin bater com a loja.
        res.json({ success: true, content: { ...DEFAULT_SITE_CONTENT, ...next } });
      }
    );
  });
});

app.get('/produtos', (req, res) => {
  res.redirect('/api/products');
});

app.post('/api/products', requireAdmin, (req, res) => {
  const product = normalizeProductPayload(req.body);
  const error = validateProduct(product);

  if (error) {
    return res.status(400).json({ error });
  }

  db.run(
    `INSERT INTO products
      (name, category, price, description, details, image, images, featured, status, stock, sale_price, promo, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      product.name,
      product.category,
      product.price,
      product.description,
      product.details,
      product.images[0],
      JSON.stringify(product.images),
      product.featured,
      product.status,
      product.stock,
      product.sale_price,
      product.promo
    ],
    function onInsert(err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao cadastrar produto.' });
      }

      res.status(201).json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const product = normalizeProductPayload(req.body);
  const error = validateProduct(product);

  if (error) {
    return res.status(400).json({ error });
  }

  db.run(
    `UPDATE products
     SET name = ?, category = ?, price = ?, description = ?, details = ?, image = ?, images = ?,
         featured = ?, status = ?, stock = ?, sale_price = ?, promo = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      product.name,
      product.category,
      product.price,
      product.description,
      product.details,
      product.images[0],
      JSON.stringify(product.images),
      product.featured,
      product.status,
      product.stock,
      product.sale_price,
      product.promo,
      req.params.id
    ],
    function onUpdate(err) {
      if (err) {
        return res.status(500).json({ error: 'Erro ao atualizar produto.' });
      }

      res.json({ success: true, updated: this.changes });
    }
  );
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function onDelete(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao remover produto.' });
    }

    res.json({ success: true, deleted: this.changes });
  });
});

const SALE_STATUSES = ['Pago', 'Separacao', 'Enviado', 'Entregue', 'Cancelado'];

app.get('/api/sales', requireAdmin, (req, res) => {
  db.all(`
    SELECT sales.*, products.name AS product_name
    FROM sales
    LEFT JOIN products ON products.id = sales.product_id
    ORDER BY sales.created_at DESC
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar vendas.' });
    }

    res.json(rows);
  });
});

app.post('/api/sales', requireAdmin, (req, res) => {
  const productId = Number(req.body.product_id);
  const customer = String(req.body.customer || '').trim();
  const quantity = Math.max(1, Math.round(Number(req.body.quantity) || 0));
  const requestedStatus = String(req.body.status || 'Pago').trim();
  const status = SALE_STATUSES.includes(requestedStatus) ? requestedStatus : 'Pago';
  const reduceStock = req.body.reduce_stock !== false && req.body.reduce_stock !== 'false';

  if (!customer || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Informe o cliente e uma quantidade valida.' });
  }

  db.get('SELECT * FROM products WHERE id = ?', [productId], (err, product) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao registrar a venda.' });
    }

    if (!product) {
      return res.status(400).json({ error: 'Selecione um produto valido.' });
    }

    const unitPrice = Number(product.sale_price) > 0 ? Number(product.sale_price) : Number(product.price);
    const providedTotal = Number(req.body.total);
    const total = Number.isFinite(providedTotal) && providedTotal > 0 ? providedTotal : unitPrice * quantity;

    db.run(
      'INSERT INTO sales (product_id, customer, quantity, total, status) VALUES (?, ?, ?, ?, ?)',
      [product.id, customer, quantity, total, status],
      function onInsert(insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: 'Erro ao registrar a venda.' });
        }

        if (reduceStock) {
          db.run('UPDATE products SET stock = MAX(0, COALESCE(stock, 0) - ?) WHERE id = ?', [quantity, product.id]);
        }

        res.status(201).json({ success: true, id: this.lastID, total });
      }
    );
  });
});

app.patch('/api/sales/:id', requireAdmin, (req, res) => {
  const requestedStatus = String(req.body.status || '').trim();

  if (!SALE_STATUSES.includes(requestedStatus)) {
    return res.status(400).json({ error: 'Status invalido.' });
  }

  db.run('UPDATE sales SET status = ? WHERE id = ?', [requestedStatus, req.params.id], function onUpdate(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao atualizar a venda.' });
    }

    res.json({ success: true, updated: this.changes });
  });
});

app.delete('/api/sales/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM sales WHERE id = ?', [req.params.id], function onDelete(err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao remover a venda.' });
    }

    res.json({ success: true, deleted: this.changes });
  });
});

app.get('/api/customers', requireAdmin, (req, res) => {
  db.all('SELECT id, name, cpf, phone, created_at FROM customers ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao buscar clientes.' });
    }

    res.json(rows);
  });
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

function startServer(port, attemptsLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`Admin: ${ADMIN_EMAIL}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Senha admin inicial: ${ADMIN_PASSWORD}`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Porta ${port} em uso. Tentando http://localhost:${nextPort}...`);
      startServer(nextPort, attemptsLeft - 1);
      return;
    }

    console.error('Erro ao iniciar o servidor:', err.message);
    process.exit(1);
  });
}

startServer(PORT);

process.on('exit', () => {
  db.close();
});
