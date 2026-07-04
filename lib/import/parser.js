// Parser de arquivos (Excel e CSV).
//
// Recebe o conteudo bruto do arquivo (Buffer) + o nome, e devolve uma tabela
// simples: { headers: [...], rows: [[celula, celula, ...], ...] }.
// Usa a biblioteca SheetJS (xlsx), que le XLSX, XLS e CSV.

const XLSX = require('xlsx');
const pdfParser = require('./pdfParser');

// Limite de seguranca: importacoes gigantes nao devem estourar a memoria do servidor.
const MAX_ROWS = 50000;

const BINARY_EXTS = ['xlsx', 'xls', 'xlsb', 'ods'];

function extensionOf(filename) {
  const parts = String(filename || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

// Zip (xlsx/ods) comeca com "PK"; OLE (xls antigo) com D0 CF 11 E0.
function looksBinary(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return true; // PK..
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true; // OLE
  return false;
}

// CSV brasileiro costuma vir em latin1 (windows-1252). Detecta e decodifica certo.
function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (utf8.includes('�')) {
    return buf.toString('latin1').replace(/^﻿/, '');
  }
  return utf8.replace(/^﻿/, '');
}

function readAs(buf, mode) {
  // sheetRows limita a leitura no proprio parse (evita estourar memoria com um
  // arquivo que declara um intervalo gigante). +2 = cabecalho + margem.
  const opts = { cellDates: false, raw: false, sheetRows: MAX_ROWS + 2 };
  if (mode === 'binary') return XLSX.read(buf, { type: 'buffer', ...opts });
  return XLSX.read(decodeText(buf), { type: 'string', ...opts });
}

// Escolhe o modo pela extensao/assinatura, mas tenta o outro se o primeiro falhar
// (assim um XLSX renomeado como .csv, ou vice-versa, ainda e' lido).
function readWorkbook(buf, filename) {
  const ext = extensionOf(filename);
  const preferBinary = looksBinary(buf) || BINARY_EXTS.includes(ext);
  const order = preferBinary ? ['binary', 'text'] : ['text', 'binary'];
  let lastErr;
  for (const mode of order) {
    try {
      return readAs(buf, mode);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('formato desconhecido');
}

// Acha a linha de cabecalho: a primeira que tem 2+ celulas preenchidas
// (pula titulos/linhas em branco no topo). Se so' existe 1 coluna, aceita 1.
function findHeaderRow(aoa) {
  for (let i = 0; i < aoa.length; i++) {
    const filled = aoa[i].filter((c) => String(c == null ? '' : c).trim() !== '').length;
    if (filled >= 2) return i;
    if (filled === 1 && aoa[i].length === 1) return i;
  }
  return 0;
}

function looksPdf(buf, filename) {
  if (extensionOf(filename) === 'pdf') return true;
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

async function parseBuffer(buf, filename) {
  if (!buf || !buf.length) {
    throw new Error('Arquivo vazio.');
  }

  if (looksPdf(buf, filename)) {
    const parsed = await pdfParser.parsePdf(buf);
    // Aplica o mesmo limite de linhas dos demais formatos.
    if (parsed.rows.length > MAX_ROWS) {
      parsed.rows = parsed.rows.slice(0, MAX_ROWS);
      parsed.truncated = true;
    }
    return parsed;
  }

  let workbook;
  try {
    workbook = readWorkbook(buf, filename);
  } catch (err) {
    throw new Error('Nao foi possivel ler o arquivo. Envie um XLSX, XLS ou CSV valido.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('A planilha nao tem nenhuma aba.');
  const sheet = workbook.Sheets[sheetName];

  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false
  });

  if (!aoa.length) throw new Error('A planilha esta vazia.');

  const headerIdx = findHeaderRow(aoa);
  const rawHeaders = aoa[headerIdx] || [];
  const headers = rawHeaders.map((h) => String(h == null ? '' : h).trim());

  const width = headers.length;
  let rows = aoa.slice(headerIdx + 1)
    .map((row) => {
      const cells = new Array(width);
      for (let i = 0; i < width; i++) cells[i] = row[i] == null ? '' : row[i];
      return cells;
    })
    // Remove linhas completamente vazias.
    .filter((cells) => cells.some((c) => String(c).trim() !== ''));

  let truncated = false;
  if (rows.length > MAX_ROWS) {
    rows = rows.slice(0, MAX_ROWS);
    truncated = true;
  }

  return { headers, rows, sheetName, truncated, maxRows: MAX_ROWS, headerRow: headerIdx };
}

module.exports = { parseBuffer, MAX_ROWS };
