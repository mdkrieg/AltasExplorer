/**
 * Content extraction for deep content search.
 *
 * Extracts user-visible text from files so it can be cached in the
 * file_content table and matched by deep search. Only the text a user
 * would actually see is extracted — markup, schema, and container
 * structure (OOXML internals etc.) are discarded.
 *
 * IMPORTANT: this module's top level must stay dependency-free apart from
 * Node built-ins. scanner.js (shared with the standalone server) requires
 * it for isSupported(); the heavy parsers (pdf-parse, mammoth, xlsx,
 * htmlparser2) are lazy-required inside their extractor functions so they
 * are only loaded when extraction actually runs.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ext (lowercase, with dot) → extractor id
const SUPPORTED_EXTENSIONS = {
  // direct text read
  '.txt': 'text', '.md': 'text', '.log': 'text', '.csv': 'text',
  '.json': 'text', '.yaml': 'text', '.yml': 'text',
  '.ini': 'text', '.cfg': 'text', '.conf': 'text',
  '.js': 'text', '.ts': 'text', '.py': 'text', '.sql': 'text',
  '.sh': 'text', '.bat': 'text', '.ps1': 'text', '.css': 'text',
  // tag-stripped via parser
  '.xml': 'xml', '.html': 'xml', '.htm': 'xml', '.svg': 'xml',
  // rich formats
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx'
};

function isSupported(filename) {
  return Object.prototype.hasOwnProperty.call(
    SUPPORTED_EXTENSIONS, path.extname(filename || '').toLowerCase());
}

/**
 * Collapse line endings, drop non-printing control characters, trim.
 * Keeps \n and \t so phrase matches can span visible whitespace naturally.
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

async function extractText(filePath) {
  return fs.promises.readFile(filePath, 'utf-8');
}

async function extractXml(filePath) {
  const htmlparser2 = require('htmlparser2');
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const chunks = [];
  let skipDepth = 0;
  const parser = new htmlparser2.Parser({
    onopentag(name) {
      if (name === 'script' || name === 'style') skipDepth++;
    },
    onclosetag(name) {
      if ((name === 'script' || name === 'style') && skipDepth > 0) skipDepth--;
    },
    ontext(text) {
      if (skipDepth === 0 && text.trim()) chunks.push(text);
    }
  }, { decodeEntities: true });
  parser.write(raw);
  parser.end();
  return chunks.join(' ');
}

async function extractPdf(filePath) {
  // pdf-parse is pinned to v1 (CommonJS); v2 is ESM-only and cannot be
  // required from the Electron main process.
  const pdfParse = require('pdf-parse');
  const buf = await fs.promises.readFile(filePath);
  const result = await pdfParse(buf);
  return result.text || '';
}

async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function extractXlsx(filePath) {
  const XLSX = require('xlsx');
  const buf = await fs.promises.readFile(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
    if (csv.trim()) parts.push(`[${sheetName}]\n${csv}`);
  }
  return parts.join('\n');
}

const EXTRACTORS = {
  text: extractText,
  xml: extractXml,
  pdf: extractPdf,
  docx: extractDocx,
  xlsx: extractXlsx
};

/**
 * Extract user-visible text from a file.
 * @param {string} filePath
 * @param {{ sizeCapBytes?: number, truncateChars?: number }} options
 * @returns {Promise<{ text: string|null, status: string, truncated: boolean, extractor: string|null, error: string|null }>}
 *   status: 'extracted' | 'truncated' | 'skipped_size' | 'error' | 'unsupported'
 */
async function extractContent(filePath, options = {}) {
  const sizeCapBytes = options.sizeCapBytes || (10 * 1024 * 1024);
  const truncateChars = options.truncateChars || 2000000;

  const ext = path.extname(filePath || '').toLowerCase();
  const extractorId = SUPPORTED_EXTENSIONS[ext];
  if (!extractorId) {
    return { text: null, status: 'unsupported', truncated: false, extractor: null, error: null };
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > sizeCapBytes) {
      return { text: null, status: 'skipped_size', truncated: false, extractor: extractorId, error: null };
    }

    let text = normalizeText(await EXTRACTORS[extractorId](filePath));
    let truncated = false;
    if (text.length > truncateChars) {
      text = text.slice(0, truncateChars);
      truncated = true;
    }
    return {
      text,
      status: truncated ? 'truncated' : 'extracted',
      truncated,
      extractor: extractorId,
      error: null
    };
  } catch (err) {
    logger.warn(`Content extraction failed: ${filePath}`, err.message);
    return { text: null, status: 'error', truncated: false, extractor: extractorId, error: err.message };
  }
}

module.exports = { SUPPORTED_EXTENSIONS, isSupported, extractContent, normalizeText };
