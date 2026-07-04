// Parser de PDF (melhor esforco), com DUAS estrategias:
//
//  1) TABELA: PDFs que sao uma planilha de precos com cabecalho (Codigo, Preco...).
//     Reconstroi colunas pela posicao x dos titulos.
//
//  2) CATALOGO (ficha): PDFs onde cada produto e' um "cartao" com linhas rotuladas,
//     tipo o catalogo de semijoias:
//         ANEL
//         AN TREVO CRAVEJADO 15mm
//         Cod. 10262  Ref. AN1774
//         R$ 72,00    Saldo: 1
//     Aqui a gente le por coluna (esquerda/direita), junta as linhas de cada cartao
//     e extrai codigo/ref/nome/categoria/preco/estoque com base nos rotulos.
//
// Em ambos os casos o resultado ({ headers, rows }) entra no MESMO fluxo do Excel/CSV.
// PDF escaneado (imagem) nao tem texto e nao da pra importar.

const PDFParser = require('pdf2json');
const mapper = require('./columnMapper');

const MAX_PAGES = 400;

function decodeText(runs) {
  const raw = runs.map((r) => r.T).join('');
  try { return decodeURIComponent(raw); } catch (e) { return raw.replace(/%[0-9A-Fa-f]{2}/g, ' ').trim(); }
}

function loadPdf(buffer) {
  // pdf2json le o ArrayBuffer subjacente ignorando o byteOffset. Buffers vindos de
  // Buffer.from(base64) ou de streams costumam ser "fatias" de um pool compartilhado
  // (offset != 0), o que faz o parser ler bytes errados ("Invalid XRef"). Copiamos
  // para um buffer proprio (sem pool, offset 0) antes de entregar ao pdf2json.
  const clean = Buffer.allocUnsafeSlow(buffer.length);
  buffer.copy(clean);
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataError', (err) => reject(err && err.parserError ? err.parserError : err));
    parser.on('pdfParser_dataReady', (data) => resolve(data));
    try {
      parser.parseBuffer(clean);
    } catch (err) {
      reject(err);
    }
  });
}

function pageItems(pg) {
  return (pg.Texts || [])
    .map((t) => ({ x: t.x, y: t.y, text: decodeText(t.R || []) }))
    .filter((it) => it.text && it.text.trim() !== '');
}

function medianGap(sortedVals) {
  const gaps = [];
  for (let i = 1; i < sortedVals.length; i++) {
    const g = sortedVals[i] - sortedVals[i - 1];
    if (g > 0.01) gaps.push(g);
  }
  if (!gaps.length) return 1;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Quebra itens em linhas (agrupa por y). Cada linha = itens ordenados por x.
function itemsToRows(items) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const ys = sorted.map((it) => it.y).sort((a, b) => a - b);
  const tol = Math.max(0.25, medianGap(ys) * 0.6);
  const rows = [];
  let current = null;
  for (const it of sorted) {
    if (!current || it.y - current.y > tol) {
      current = { y: it.y, items: [it] };
      rows.push(current);
    } else {
      current.items.push(it);
    }
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

// ============================================================
// Estrategia 1: TABELA (cabecalho + colunas por x)
// ============================================================
function mergeHeaderItems(items) {
  if (items.length < 2) return items.map((it) => ({ x: it.x, text: it.text }));
  const gaps = [];
  for (let i = 1; i < items.length; i++) gaps.push(items[i].x - items[i - 1].x);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  const tol = Math.max(0.6, med * 0.35);
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && it.x - last.lastX < tol) {
      last.text = `${last.text} ${it.text}`.trim();
      last.lastX = it.x;
    } else {
      merged.push({ x: it.x, lastX: it.x, text: it.text });
    }
  }
  return merged.map((m) => ({ x: m.x, text: m.text }));
}

function headerScore(cells) {
  return Object.keys(mapper.detectMapping(cells)).length;
}

function tryTableMode(pages) {
  const pageRows = [];
  pages.slice(0, MAX_PAGES).forEach((pg, pi) => {
    const items = pageItems(pg);
    if (!items.length) return;
    itemsToRows(items).forEach((r) => pageRows.push({ page: pi, y: r.y, items: r.items }));
  });
  if (!pageRows.length) return null;

  let headerIdx = -1;
  let bestScore = 1; // exige >= 2 colunas reconhecidas
  for (let i = 0; i < pageRows.length; i++) {
    const cells = mergeHeaderItems(pageRows[i].items).map((it) => it.text);
    const score = headerScore(cells);
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  if (headerIdx < 0) return null;

  const anchors = mergeHeaderItems(pageRows[headerIdx].items);
  const headers = anchors.map((a) => a.text);
  const headerKey = headers.join('|').toLowerCase();

  const rows = [];
  for (let i = headerIdx + 1; i < pageRows.length; i++) {
    const cells = new Array(anchors.length).fill('');
    for (const it of pageRows[i].items) {
      let best = 0;
      let bestDist = Infinity;
      for (let a = 0; a < anchors.length; a++) {
        const d = Math.abs(it.x - anchors[a].x);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      cells[best] = cells[best] ? `${cells[best]} ${it.text}` : it.text;
    }
    const trimmed = cells.map((c) => c.trim());
    const filled = trimmed.filter((c) => c !== '').length;
    if (filled < 2) continue;
    if (trimmed.join('|').toLowerCase() === headerKey) continue;
    rows.push(trimmed);
  }
  if (!rows.length) return null;
  return { headers, rows, sheetName: `PDF tabela (${pages.length} pag.)`, truncated: false, maxRows: 50000, headerRow: 0 };
}

// ============================================================
// Estrategia 2: CATALOGO / FICHA (cartoes com rotulos Cod./Ref./R$/Saldo)
// ============================================================
const RE_COD = /c[óo]d\.?\s*([^\s]+)\s+ref\.?\s*(.+)$/i;
const RE_PRICE = /r\$\s*([\d.,]+)\s*saldo\s*:?\s*(\d+)/i;

// Categorias comuns de joias/semijoias (ajuda a reconhecer o rotulo mesmo que
// apareca poucas vezes). Comparadas sem acento/maiuscula.
const BUILTIN_CATS = new Set([
  'anel', 'aneis', 'brinco', 'brincos', 'colar', 'colares', 'pulseira', 'pulseiras',
  'tornozeleira', 'tornozeleiras', 'conjunto', 'conjuntos', 'pingente', 'pingentes',
  'piercing', 'piercings', 'corrente', 'correntes', 'alianca', 'aliancas', 'gargantilha',
  'choker', 'berloque', 'berloques', 'tiara', 'broche', 'anel masculino', 'escapulario'
]);

// Rotulo de categoria: linha curta, TODA em maiuscula, sem numero nem rotulos.
function isCategoryLabel(s) {
  const t = String(s || '').trim();
  if (t.length < 3 || t.length > 24) return false;
  if (/\d/.test(t)) return false;
  if (/r\$|saldo|c[óo]d|ref|cliente|cat[aá]logo/i.test(t)) return false;
  return t === t.toUpperCase() && /[A-ZÀ-Ú]/.test(t);
}

// Categoria "de verdade": parece rotulo E (e' uma categoria conhecida de joia OU
// se repete no documento). Assim um pedaco de nome em maiuscula ("CRAVEJADO",
// que aparece uma vez) nao vira categoria.
function isKnownCategory(line, catFreq) {
  const t = String(line || '').trim();
  if (!isCategoryLabel(t)) return false;
  if (BUILTIN_CATS.has(mapper.normalizeHeader(t))) return true;
  return (catFreq[t] || 0) >= 2;
}

// Le o PDF em linhas, coluna por coluna (esquerda depois direita), pagina a pagina.
function catalogLines(pages) {
  const lines = [];
  pages.slice(0, MAX_PAGES).forEach((pg) => {
    const items = pageItems(pg);
    if (!items.length) return;
    const width = pg.Width || (Math.max(...items.map((it) => it.x)) + 1);
    const mid = width / 2;
    const columns = [items.filter((it) => it.x < mid), items.filter((it) => it.x >= mid)];
    for (const colItems of columns) {
      if (!colItems.length) continue;
      itemsToRows(colItems).forEach((r) => {
        const text = r.items.map((it) => it.text).join(' ').replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
      });
    }
  });
  return lines;
}

function tryRecordMode(pages) {
  const lines = catalogLines(pages);
  if (!lines.length) return null;

  // Frequencia dos rotulos de categoria (categoria de verdade se repete).
  const catFreq = {};
  for (const L of lines) {
    const t = L.trim();
    if (isCategoryLabel(t)) catFreq[t] = (catFreq[t] || 0) + 1;
  }

  const headers = ['Codigo', 'Cod Fornecedor', 'Categoria', 'Nome', 'Preco', 'Estoque'];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const cod = lines[i].match(RE_COD);
    if (!cod) continue;
    const sku = cod[1];
    const ref = (cod[2] || '').trim();

    // preco/estoque: nas proximas linhas
    let price = '';
    let stock = '';
    for (let k = i + 1; k <= i + 2 && k < lines.length; k++) {
      const pm = lines[k].match(RE_PRICE);
      if (pm) { price = pm[1]; stock = pm[2]; break; }
    }
    if (!sku || !price) continue; // precisa de codigo e preco pra ser um produto

    // Sobe do "Cod." juntando as linhas do nome (que pode ter quebrado em varias)
    // ate achar a categoria (topo do cartao) ou o limite do produto anterior.
    const block = [];
    for (let b = i - 1; b >= 0 && block.length < 6; b--) {
      const L = lines[b].trim();
      if (RE_COD.test(L) || RE_PRICE.test(L)) break; // comecou o produto de cima
      block.unshift(L);
      if (isKnownCategory(L, catFreq)) break; // categoria e' o topo do cartao
    }
    let category = '';
    if (block.length && isKnownCategory(block[0], catFreq)) {
      category = block.shift();
    }
    const name = block.join(' ').replace(/\s+/g, ' ').trim();

    rows.push([sku, ref, category, name, price, stock]);
  }
  if (!rows.length) return null;
  return { headers, rows, sheetName: `PDF catalogo (${pages.length} pag.)`, truncated: false, maxRows: 50000, headerRow: 0 };
}

async function parsePdf(buffer) {
  const data = await loadPdf(buffer);
  const pages = (data && data.Pages) || [];
  if (!pages.length) throw new Error('PDF sem paginas legiveis.');

  const anyText = pages.some((pg) => (pg.Texts || []).length > 0);
  if (!anyText) {
    throw new Error('Nao encontrei texto no PDF. Se for um PDF escaneado (imagem), envie um Excel ou CSV.');
  }

  // 1) Tenta como tabela (cabecalho com colunas). 2) Senao, como catalogo/ficha.
  const table = tryTableMode(pages);
  if (table) return table;
  const records = tryRecordMode(pages);
  if (records) return records;

  throw new Error('Nao reconheci uma tabela nem fichas de produto no PDF. Tente um Excel ou CSV, ou um PDF com os dados em tabela.');
}

module.exports = { parsePdf, MAX_PAGES };
