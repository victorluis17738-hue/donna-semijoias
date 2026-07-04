// Leitura inteligente de colunas.
//
// O fornecedor pode nomear as colunas de qualquer jeito ("Codigo", "SKU", "Ref"...).
// Aqui a gente reconhece automaticamente o que cada coluna representa, sem depender
// do nome exato. Tudo neste arquivo e' funcao pura (facil de testar): recebe cabecalhos
// e celulas, devolve um produto normalizado.

// Normaliza um texto para comparar: minusculo, sem acento, sem pontuacao, espacos colapsados.
function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Campos que sabemos reconhecer, em ordem de prioridade (mais especifico primeiro).
// `exclude`: se o cabecalho contiver esse termo, NAO e' esse campo (evita "preco de custo"
// virar "preco de venda", por exemplo).
const FIELD_DEFS = [
  { field: 'supplier_code', syn: ['codigo do fornecedor', 'cod fornecedor', 'codigo fornecedor', 'cod forn', 'fornecedor'] },
  { field: 'sku', syn: ['sku', 'codigo', 'cod', 'codigo do produto', 'codigo interno', 'referencia', 'ref', 'codigo de barras', 'ean', 'gtin', 'codigo sku'], exclude: ['fornecedor'] },
  { field: 'cost_price', syn: ['preco de custo', 'preco custo', 'custo', 'valor de custo', 'custo unitario'] },
  { field: 'price', syn: ['preco de venda', 'preco venda', 'preco', 'valor', 'preco final', 'preco unitario', 'vlr', 'vlr venda', 'valor venda', 'valor unitario', 'preco sugerido'], exclude: ['custo'] },
  { field: 'stock', syn: ['estoque', 'quantidade', 'qtd', 'qtde', 'qte', 'saldo', 'estoque atual', 'disponivel', 'quantidade em estoque', 'qtd estoque', 'em estoque'] },
  { field: 'collection', syn: ['colecao', 'collection', 'linha colecao'] },
  { field: 'material', syn: ['material', 'materia prima', 'composicao'] },
  { field: 'banho', syn: ['banho', 'banho de ouro', 'acabamento', 'tipo de banho'] },
  { field: 'color', syn: ['cor', 'cores', 'coloracao'] },
  { field: 'weight', syn: ['peso', 'peso g', 'peso gramas', 'peso liquido', 'gramatura'] },
  { field: 'dimensions', syn: ['dimensoes', 'medidas', 'tamanho', 'medida', 'comprimento'] },
  { field: 'subcategory', syn: ['subcategoria', 'sub categoria', 'subgrupo', 'sub grupo'] },
  { field: 'category', syn: ['categoria', 'grupo', 'tipo', 'linha', 'departamento', 'secao', 'familia', 'segmento'], exclude: ['sub'] },
  { field: 'image_url', syn: ['imagem', 'url da imagem', 'url imagem', 'foto', 'fotos', 'link da imagem', 'imagem url', 'image', 'url', 'link', 'link foto', 'foto url'] },
  { field: 'name', syn: ['nome', 'nome do produto', 'produto', 'titulo', 'item', 'peca', 'nome peca', 'descricao curta', 'nome da peca'] },
  { field: 'description', syn: ['descricao', 'detalhes', 'descricao do produto', 'descricao completa', 'descricao longa', 'observacao', 'observacoes', 'obs', 'detalhe', 'descritivo'] }
];

// Rotulos amigaveis (para mostrar no preview qual coluna virou qual campo).
const FIELD_LABELS = {
  sku: 'SKU / Codigo',
  supplier_code: 'Codigo do fornecedor',
  name: 'Nome',
  description: 'Descricao',
  category: 'Categoria',
  subcategory: 'Subcategoria',
  collection: 'Colecao',
  price: 'Preco de venda',
  cost_price: 'Preco de custo',
  stock: 'Estoque',
  material: 'Material',
  banho: 'Banho',
  color: 'Cor',
  weight: 'Peso',
  dimensions: 'Dimensoes',
  image_url: 'Imagem'
};

// Colunas do produto que compoem o texto "Detalhes" quando existem.
const DETAIL_FIELDS = [
  ['collection', 'Colecao'],
  ['subcategory', 'Subcategoria'],
  ['material', 'Material'],
  ['banho', 'Banho'],
  ['color', 'Cor'],
  ['weight', 'Peso'],
  ['dimensions', 'Dimensoes']
];

// A sequencia de palavras `a` contem `b` como bloco contiguo de palavras inteiras?
// Ex.: phraseContains('preco venda', 'preco') = true; phraseContains('grupo', 'subgrupo') = false.
function phraseContains(a, b) {
  const at = a.split(' ');
  const bt = b.split(' ');
  if (!bt.length || bt.length > at.length) return false;
  for (let i = 0; i + bt.length <= at.length; i++) {
    let ok = true;
    for (let j = 0; j < bt.length; j++) {
      if (at[i + j] !== bt[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Pontua o quanto um cabecalho combina com um campo. 0 = nao combina.
// So' casa por palavra inteira (nunca por pedaco de palavra), pra evitar falsos positivos.
function scoreHeaderForField(hNorm, def) {
  if (!hNorm) return 0;
  if (def.exclude && def.exclude.some((x) => phraseContains(hNorm, x))) return 0;
  let best = 0;
  for (const syn of def.syn) {
    if (hNorm === syn) best = Math.max(best, 100);
    else if (phraseContains(hNorm, syn)) best = Math.max(best, 80);
  }
  return best;
}

// Recebe a lista de cabecalhos e devolve { campo: indiceDaColuna }.
// Cada coluna e' usada por no maximo um campo (o de maior pontuacao, respeitando a ordem).
function detectMapping(headers) {
  const norm = headers.map(normalizeHeader);
  const used = new Array(headers.length).fill(false);
  const mapping = {};
  for (const def of FIELD_DEFS) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < norm.length; i++) {
      if (used[i]) continue;
      const score = scoreHeaderForField(norm[i], def);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= 55) {
      mapping[def.field] = bestIdx;
      used[bestIdx] = true;
    }
  }
  return mapping;
}

// Resumo legivel do mapeamento, para exibir no preview.
function describeMapping(headers, mapping) {
  const recognized = [];
  const usedIdx = new Set();
  for (const field of Object.keys(FIELD_LABELS)) {
    const idx = mapping[field];
    if (idx == null) continue;
    usedIdx.add(idx);
    recognized.push({ field, label: FIELD_LABELS[field], column: String(headers[idx] || '').trim() });
  }
  const ignored = headers
    .map((h, i) => ({ h: String(h || '').trim(), i }))
    .filter((x) => x.h && !usedIdx.has(x.i))
    .map((x) => x.h);
  return { recognized, ignored };
}

// Conjunto de colunas do produto que o arquivo realmente traz (guia o UPDATE:
// so' sobrescreve o que veio no arquivo, preservando o resto).
function presentFields(mapping) {
  return {
    sku: mapping.sku != null,
    name: mapping.name != null,
    description: mapping.description != null,
    category: mapping.category != null,
    price: mapping.price != null,
    cost_price: mapping.cost_price != null,
    stock: mapping.stock != null,
    supplier_code: mapping.supplier_code != null,
    image: mapping.image_url != null,
    details: DETAIL_FIELDS.some(([f]) => mapping[f] != null)
  };
}

// Converte "R$ 1.299,90" / "1299.90" / "129,90" em numero. Retorna NaN se invalido.
function parseMoney(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value;
  let s = String(value).replace(/[^\d.,-]/g, '').trim();
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Formato brasileiro: ponto = milhar, virgula = decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Estoque: inteiro >= 0. Retorna null quando a celula esta vazia.
function parseStock(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Math.max(0, Math.trunc(value));
  const s = String(value).replace(/[^\d-]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

// Divide uma celula de imagem em varias URLs (separadores , ; |) e deixa cada uma usavel.
function parseImages(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return [];
  return raw
    .split(/[;,|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeImageRef);
}

// URL completa -> usa direto. Caminho "/..." -> usa direto. Nome solto -> assume /assets/products/.
function normalizeImageRef(ref) {
  if (/^https?:\/\//i.test(ref) || ref.startsWith('/')) return ref;
  return `/assets/products/${ref.replace(/^\.?\/*/, '')}`;
}

// Aplica o mapeamento a uma linha (array de celulas alinhado aos cabecalhos)
// e devolve um produto normalizado. Campos ausentes ficam null (nao vazio),
// para o servico saber o que NAO deve sobrescrever num update.
function mapRow(cells, mapping) {
  const get = (field) => {
    const idx = mapping[field];
    if (idx == null) return '';
    return String(cells[idx] == null ? '' : cells[idx]).trim();
  };
  const has = (field) => mapping[field] != null;

  const sku = get('sku') || null;
  const name = has('name') ? get('name') || null : null;
  const description = has('description') ? get('description') || null : null;
  const category = has('category') ? get('category') || null : null;
  const supplier_code = has('supplier_code') ? get('supplier_code') || null : null;

  const price = has('price') ? parseMoney(get('price')) : NaN;
  const cost_price = has('cost_price') ? parseMoney(get('cost_price')) : NaN;
  const stock = has('stock') ? parseStock(get('stock')) : null;
  const images = has('image_url') ? parseImages(get('image_url')) : null;

  // Detalhes = atributos extras concatenados ("Material: Prata. Banho: Ouro 18k.").
  const detailParts = [];
  for (const [field, label] of DETAIL_FIELDS) {
    if (!has(field)) continue;
    const v = get(field);
    if (v) detailParts.push(`${label}: ${v}`);
  }
  const details = detailParts.length ? detailParts.join('. ') : null;

  return {
    sku,
    name,
    description,
    category,
    supplier_code,
    price: Number.isFinite(price) ? price : null,
    cost_price: Number.isFinite(cost_price) ? cost_price : null,
    stock,
    images,
    details
  };
}

// Chave de identidade do produto: SKU se existir, senao o nome normalizado.
function productKey(mapped) {
  if (mapped.sku) return `sku:${mapped.sku.trim().toLowerCase()}`;
  if (mapped.name) return `name:${normalizeHeader(mapped.name)}`;
  return null;
}

// Linha totalmente vazia? (nenhum campo util preenchido)
function isEmptyRow(mapped) {
  return !mapped.sku && !mapped.name && !mapped.description &&
    mapped.price == null && mapped.stock == null &&
    (!mapped.images || !mapped.images.length) && !mapped.category;
}

module.exports = {
  normalizeHeader,
  detectMapping,
  describeMapping,
  presentFields,
  mapRow,
  productKey,
  isEmptyRow,
  parseMoney,
  parseStock,
  parseImages,
  FIELD_DEFS,
  FIELD_LABELS
};
