// Servico de Importacao de Catalogo.
//
// Orquestra as etapas: preview (analisar sem gravar), commit (gravar em lote,
// em segundo plano, com progresso) e historico (logs + relatorio de erros).
//
// Regras principais:
// - SKU e' a identidade do produto. Se ja existe -> ATUALIZA; se nao -> CRIA.
// - Sem SKU no arquivo, casa por nome (protege o catalogo demo, que nao tem SKU).
// - UPDATE so' sobrescreve os campos que vieram no arquivo (preserva o resto).
// - Uma linha invalida NUNCA interrompe a importacao: vira erro e segue.
// - "Desativar ausentes" muda status para 'draft' (nunca apaga) e so' mexe em
//   produtos COM SKU (nao toca nos cadastrados manualmente, que nao tem SKU).

const db = require('./../../db');
const mapper = require('./columnMapper');
const parser = require('./parser');

const q = (text, params) => db.query(text, params);

const INSERT_BATCH = 400;   // linhas por INSERT
const UPDATE_BATCH = 300;   // linhas por UPDATE
const DEACT_BATCH = 500;    // ids por desativacao
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;

const uploads = new Map();  // uploadId -> sessao de preview em memoria
const jobs = new Map();     // jobId -> progresso da importacao

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function cleanup() {
  const now = Date.now();
  for (const [k, v] of uploads) if (v.expiresAt < now) uploads.delete(k);
  for (const [k, v] of jobs) if (v.finishedAt && now - v.finishedAt > JOB_TTL_MS) jobs.delete(k);
}

// ============================================================
// Schema: colunas novas + indice unico de SKU + tabela de logs.
// Chamado uma vez na inicializacao (idempotente).
// ============================================================
async function ensureSchema() {
  await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT');
  await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price DOUBLE PRECISION');
  await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_code TEXT');
  // UNIQUE permite varios NULL (produtos sem SKU convivem); unico apenas entre SKUs reais.
  await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku)');
  await q(`CREATE TABLE IF NOT EXISTS import_logs (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now(),
    user_email TEXT,
    filename TEXT,
    total INTEGER DEFAULT 0,
    inserted INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    ignored INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    deactivated INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'done',
    errors_json TEXT
  )`);
}

// ============================================================
// Preview: le o arquivo, reconhece as colunas e classifica cada linha
// (nova / atualizar / erro / ignorada) SEM gravar nada.
// ============================================================
async function preparePreview(buf, filename, userEmail) {
  const parsed = parser.parseBuffer(buf, filename);
  const mapping = mapper.detectMapping(parsed.headers);
  const present = mapper.presentFields(mapping);
  const describe = mapper.describeMapping(parsed.headers, mapping);

  if (!present.sku && !present.name && !present.description) {
    throw new Error('Nao reconheci uma coluna de SKU/codigo nem de nome. Confira se a planilha tem cabecalho.');
  }
  if (!present.price && !present.sku && !present.name) {
    throw new Error('A planilha precisa de ao menos uma coluna de identificacao (SKU ou nome).');
  }

  const seen = new Set();
  const candidates = [];
  const errors = [];
  let ignored = 0;

  parsed.rows.forEach((cells, i) => {
    const rowNum = parsed.headerRow + 2 + i; // linha aproximada na planilha
    const mapped = mapper.mapRow(cells, mapping);
    if (mapper.isEmptyRow(mapped)) { ignored += 1; return; }

    const name = mapped.name || mapped.description || null;
    const description = mapped.description || mapped.name || null;
    const key = mapper.productKey({ sku: mapped.sku, name });
    if (!key) {
      errors.push({ row: rowNum, sku: mapped.sku || '', name: name || '', reason: 'Linha sem SKU nem nome' });
      return;
    }
    if (seen.has(key)) { ignored += 1; return; } // duplicado dentro do proprio arquivo
    seen.add(key);
    candidates.push({ mapped, name, description, key, rowNum });
  });

  // Carrega o catalogo atual para decidir novo x atualizar (casa por SKU, senao por nome).
  const existing = (await q('SELECT id, sku, name FROM products')).rows;
  const bySku = new Map();
  const byName = new Map();
  for (const p of existing) {
    if (p.sku) bySku.set(String(p.sku).trim().toLowerCase(), p);
    if (p.name) {
      const nk = mapper.normalizeHeader(p.name);
      if (!byName.has(nk)) byName.set(nk, p);
    }
  }

  const tagged = [];
  let willInsert = 0;
  let willUpdate = 0;
  for (const c of candidates) {
    let match = null;
    if (c.mapped.sku) match = bySku.get(c.mapped.sku.trim().toLowerCase());
    if (!match && c.name) match = byName.get(mapper.normalizeHeader(c.name));

    if (match) {
      c.action = 'update';
      c.existingId = match.id;
      willUpdate += 1;
      tagged.push(c);
    } else {
      // Produto novo: precisa satisfazer os campos obrigatorios (NOT NULL).
      if (!c.name) {
        errors.push({ row: c.rowNum, sku: c.mapped.sku || '', name: '', reason: 'Produto novo sem nome' });
        continue;
      }
      if (c.mapped.price == null || !(c.mapped.price > 0)) {
        errors.push({ row: c.rowNum, sku: c.mapped.sku || '', name: c.name, reason: 'Produto novo sem preco valido' });
        continue;
      }
      c.action = 'insert';
      willInsert += 1;
      tagged.push(c);
    }
  }

  const importedSkus = tagged.filter((c) => c.mapped.sku).map((c) => c.mapped.sku.trim().toLowerCase());
  const uploadId = nextId('up');
  uploads.set(uploadId, {
    id: uploadId,
    filename,
    userEmail,
    mapping,
    present,
    tagged,
    importedSkus,
    errors,
    ignored,
    totalRows: parsed.rows.length,
    createdAt: Date.now(),
    expiresAt: Date.now() + UPLOAD_TTL_MS
  });
  cleanup();

  const sample = tagged.slice(0, 15).map((c) => ({
    action: c.action,
    sku: c.mapped.sku || '',
    name: c.name,
    category: c.mapped.category || '',
    price: c.mapped.price,
    stock: c.mapped.stock
  }));

  return {
    uploadId,
    filename,
    sheet: parsed.sheetName,
    truncated: parsed.truncated,
    maxRows: parsed.maxRows,
    mapping: describe,
    stats: {
      total: parsed.rows.length,
      found: candidates.length,
      willInsert,
      willUpdate,
      ignored,
      errors: errors.length
    },
    sample,
    errors: errors.slice(0, 100)
  };
}

// ============================================================
// Commit: dispara a gravacao em segundo plano e devolve um jobId.
// ============================================================
function startCommit(uploadId, options, userEmail) {
  const up = uploads.get(uploadId);
  if (!up) throw new Error('Sessao de importacao expirada. Envie o arquivo novamente.');

  const jobId = nextId('job');
  const job = {
    id: jobId,
    status: 'running',
    filename: up.filename,
    total: up.tagged.length,
    processed: 0,
    inserted: 0,
    updated: 0,
    deactivated: 0,
    errorsCount: up.errors.length,
    startedAt: Date.now(),
    finishedAt: null,
    message: ''
  };
  jobs.set(jobId, job);

  runJob(job, up, Boolean(options && options.deactivateMissing), userEmail)
    .catch((err) => {
      job.status = 'error';
      job.message = err.message || 'Falha na importacao.';
      job.finishedAt = Date.now();
      persistLog(job, up, 'error').catch(() => {});
    });

  return jobId;
}

async function runJob(job, up, deactivateMissing, userEmail) {
  const inserts = up.tagged.filter((c) => c.action === 'insert');
  const updates = up.tagged.filter((c) => c.action === 'update');

  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    await insertBatch(inserts.slice(i, i + INSERT_BATCH));
    job.inserted += Math.min(INSERT_BATCH, inserts.length - i);
    job.processed = job.inserted + job.updated;
    await yieldToLoop();
  }

  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    await updateBatch(updates.slice(i, i + UPDATE_BATCH), up.present);
    job.updated += Math.min(UPDATE_BATCH, updates.length - i);
    job.processed = job.inserted + job.updated;
    await yieldToLoop();
  }

  if (deactivateMissing && up.importedSkus.length) {
    job.deactivated = await deactivateMissingSkus(up.importedSkus);
  }

  job.status = 'done';
  job.finishedAt = Date.now();
  await persistLog(job, up, 'done');
  uploads.delete(up.id);
}

// ---- gravacao em lote -------------------------------------------------------

// INSERT multi-linha. ON CONFLICT (sku) atualiza caso o SKU ja tenha surgido
// (idempotente: reenviar o mesmo arquivo nao duplica).
async function insertBatch(batch) {
  if (!batch.length) return;
  const COLS = 11;
  const values = [];
  const params = [];
  batch.forEach((c, ri) => {
    const m = c.mapped;
    const imgs = m.images && m.images.length ? m.images : [];
    const row = [
      m.sku || null,
      c.name,
      m.category || 'Sem categoria',
      m.price,
      c.description || c.name,
      m.details || '',
      imgs[0] || '',
      JSON.stringify(imgs),
      m.stock == null ? 0 : m.stock,
      m.cost_price == null ? null : m.cost_price,
      m.supplier_code || null
    ];
    const base = ri * COLS;
    const ph = row.map((_, k) => `$${base + k + 1}`);
    values.push(`(${ph.join(',')}, 'active', now(), now())`);
    params.push(...row);
  });

  const sql = `INSERT INTO products
      (sku, name, category, price, description, details, image, images, stock, cost_price, supplier_code, status, created_at, updated_at)
    VALUES ${values.join(',')}
    ON CONFLICT (sku) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, products.name),
      category = COALESCE(EXCLUDED.category, products.category),
      price = COALESCE(EXCLUDED.price, products.price),
      description = COALESCE(EXCLUDED.description, products.description),
      details = COALESCE(EXCLUDED.details, products.details),
      image = COALESCE(EXCLUDED.image, products.image),
      images = COALESCE(EXCLUDED.images, products.images),
      stock = COALESCE(EXCLUDED.stock, products.stock),
      cost_price = COALESCE(EXCLUDED.cost_price, products.cost_price),
      supplier_code = COALESCE(EXCLUDED.supplier_code, products.supplier_code),
      updated_at = now()`;
  await q(sql, params);
}

// UPDATE em lote via VALUES. COALESCE preserva o que NAO veio no arquivo
// (celula vazia = mantem o valor atual do banco).
async function updateBatch(batch, present) {
  if (!batch.length) return;

  const cols = [{ name: 'id', type: 'integer', get: (c) => c.existingId }];
  if (present.name) cols.push({ name: 'name', type: 'text', get: (c) => c.name || null });
  if (present.description) cols.push({ name: 'description', type: 'text', get: (c) => c.description || null });
  if (present.category) cols.push({ name: 'category', type: 'text', get: (c) => c.mapped.category || null });
  if (present.price) cols.push({ name: 'price', type: 'double precision', get: (c) => (c.mapped.price == null ? null : c.mapped.price) });
  if (present.cost_price) cols.push({ name: 'cost_price', type: 'double precision', get: (c) => (c.mapped.cost_price == null ? null : c.mapped.cost_price) });
  if (present.stock) cols.push({ name: 'stock', type: 'integer', get: (c) => (c.mapped.stock == null ? null : c.mapped.stock) });
  if (present.supplier_code) cols.push({ name: 'supplier_code', type: 'text', get: (c) => c.mapped.supplier_code || null });
  if (present.details) cols.push({ name: 'details', type: 'text', get: (c) => c.mapped.details || null });
  if (present.image) {
    cols.push({ name: 'image', type: 'text', get: (c) => (c.mapped.images && c.mapped.images[0]) || null });
    cols.push({ name: 'images', type: 'text', get: (c) => (c.mapped.images && c.mapped.images.length ? JSON.stringify(c.mapped.images) : null) });
  }

  const params = [];
  let p = 0;
  const rowsSql = batch.map((c, ri) => {
    const ph = cols.map((col) => {
      params.push(col.get(c));
      p += 1;
      return ri === 0 ? `$${p}::${col.type}` : `$${p}`;
    });
    return `(${ph.join(',')})`;
  });

  const setClause = cols
    .filter((col) => col.name !== 'id')
    .map((col) => `${col.name} = COALESCE(v.${col.name}, p.${col.name})`)
    .concat('updated_at = now()')
    .join(', ');

  const sql = `UPDATE products AS p SET ${setClause}
    FROM (VALUES ${rowsSql.join(',')}) AS v(${cols.map((c) => c.name).join(',')})
    WHERE p.id = v.id`;
  await q(sql, params);
}

// Desativa (status 'draft') produtos COM SKU que nao vieram no catalogo. Nunca apaga.
async function deactivateMissingSkus(importedSkus) {
  const importedSet = new Set(importedSkus);
  const active = (await q("SELECT id, sku FROM products WHERE sku IS NOT NULL AND status = 'active'")).rows;
  const ids = active
    .filter((row) => !importedSet.has(String(row.sku).trim().toLowerCase()))
    .map((row) => row.id);

  let total = 0;
  for (let i = 0; i < ids.length; i += DEACT_BATCH) {
    const batch = ids.slice(i, i + DEACT_BATCH);
    const ph = batch.map((_, k) => `$${k + 1}`).join(',');
    const res = await q(`UPDATE products SET status = 'draft', updated_at = now() WHERE id IN (${ph})`, batch);
    total += res.rowCount || 0;
    await yieldToLoop();
  }
  return total;
}

async function persistLog(job, up, status) {
  const duration = (job.finishedAt || Date.now()) - job.startedAt;
  const total = up.totalRows;
  await q(
    `INSERT INTO import_logs
      (user_email, filename, total, inserted, updated, ignored, errors, deactivated, duration_ms, status, errors_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      up.userEmail || '',
      up.filename || '',
      total,
      job.inserted,
      job.updated,
      up.ignored,
      up.errors.length,
      job.deactivated,
      duration,
      status,
      JSON.stringify(up.errors || [])
    ]
  );
}

// ============================================================
// Consultas para o painel (progresso, historico, relatorio de erros).
// ============================================================
function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const elapsed = (job.finishedAt || Date.now()) - job.startedAt;
  const percent = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 100;
  const rate = job.processed > 0 && elapsed > 0 ? job.processed / elapsed : 0;
  const etaMs = job.status === 'running' && rate > 0 ? Math.round((job.total - job.processed) / rate) : 0;
  return {
    id: job.id,
    status: job.status,
    filename: job.filename,
    total: job.total,
    processed: job.processed,
    inserted: job.inserted,
    updated: job.updated,
    deactivated: job.deactivated,
    errors: job.errorsCount,
    percent,
    elapsedMs: elapsed,
    etaMs,
    message: job.message
  };
}

async function listLogs(limit = 50) {
  const rows = (await q(
    `SELECT id, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at, user_email, filename,
            total, inserted, updated, ignored, errors, deactivated, duration_ms, status
     FROM import_logs ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  )).rows;
  return rows;
}

async function getLogErrors(id) {
  const row = (await q('SELECT filename, errors_json FROM import_logs WHERE id = $1', [Number(id)])).rows[0];
  if (!row) return null;
  let errors = [];
  try { errors = JSON.parse(row.errors_json || '[]'); } catch (e) { errors = []; }
  return { filename: row.filename, errors };
}

// Monta o CSV de erros (para download).
function errorsToCsv(errors) {
  const header = 'linha;sku;nome;motivo';
  const escape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = errors.map((e) => [e.row, e.sku, e.name, e.reason].map(escape).join(';'));
  return '﻿' + [header, ...lines].join('\r\n');
}

module.exports = {
  ensureSchema,
  preparePreview,
  startCommit,
  getJob,
  listLogs,
  getLogErrors,
  errorsToCsv
};
