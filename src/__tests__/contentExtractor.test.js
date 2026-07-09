/**
 * @file Unit tests for contentExtractor (deep content search extraction).
 *
 * Strategy: fixtures are generated on the fly in a temp directory —
 * a minimal hand-assembled PDF, a minimal OOXML .docx built with adm-zip,
 * and an .xlsx round-tripped through SheetJS itself. This keeps binary
 * blobs out of the repo while still exercising the real parsers.
 */

jest.mock('../logger');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SUPPORTED_EXTENSIONS, isSupported, extractContent, normalizeText } = require('../contentExtractor');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-content-test-'));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

function writeFixture(name, data) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, data);
  return p;
}

/** Minimal single-page PDF with one text object and a correct xref table. */
function buildMinimalPdf(text) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
    '/Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    pdf += offsets[i].toString().padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Minimal OOXML .docx containing a single paragraph. */
function buildMinimalDocx(text) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

function buildMinimalXlsx(rows) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('contentExtractor - isSupported()', () => {
  it('recognizes supported extensions case-insensitively', () => {
    expect(isSupported('notes.txt')).toBe(true);
    expect(isSupported('REPORT.PDF')).toBe(true);
    expect(isSupported('data.Xlsx')).toBe(true);
    expect(isSupported('doc.docx')).toBe(true);
    expect(isSupported('conf.yaml')).toBe(true);
  });

  it('rejects unsupported and missing extensions', () => {
    expect(isSupported('image.png')).toBe(false);
    expect(isSupported('archive.zip')).toBe(false);
    expect(isSupported('noext')).toBe(false);
    expect(isSupported('')).toBe(false);
    expect(isSupported(null)).toBe(false);
  });

  it('maps every extension to a known extractor id', () => {
    const ids = new Set(['text', 'xml', 'pdf', 'docx', 'xlsx']);
    for (const id of Object.values(SUPPORTED_EXTENSIONS)) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe('contentExtractor - normalizeText()', () => {
  it('collapses CRLF and strips control characters, keeping \\n and \\t', () => {
    expect(normalizeText('a\r\nb\rc\x00d\te')).toBe('a\nb\ncd\te');
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText('')).toBe('');
  });
});

describe('contentExtractor - extractContent() per type', () => {
  it('reads plain text directly', async () => {
    const p = writeFixture('sample.txt', 'PLC ladder logic notes\r\nline two');
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.extractor).toBe('text');
    expect(res.text).toBe('PLC ladder logic notes\nline two');
  });

  it('strips XML tags via parser, keeping only element text', async () => {
    const p = writeFixture('sample.xml',
      '<?xml version="1.0"?><root attr="not indexed"><item>alpha</item><item>beta</item></root>');
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.extractor).toBe('xml');
    expect(res.text).toContain('alpha');
    expect(res.text).toContain('beta');
    expect(res.text).not.toContain('root');
    expect(res.text).not.toContain('not indexed');
  });

  it('skips script/style content in HTML', async () => {
    const p = writeFixture('sample.html',
      '<html><head><style>.x{color:red}</style><script>var hidden=1;</script></head>' +
      '<body><p>visible words</p></body></html>');
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.text).toContain('visible words');
    expect(res.text).not.toContain('hidden');
    expect(res.text).not.toContain('color:red');
  });

  it('extracts the PDF text layer', async () => {
    const p = writeFixture('sample.pdf', buildMinimalPdf('Hello Atlas PDF'));
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.extractor).toBe('pdf');
    expect(res.text).toContain('Hello Atlas PDF');
  });

  it('extracts readable text from .docx via mammoth', async () => {
    const p = writeFixture('sample.docx', buildMinimalDocx('quarterly maintenance report'));
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.extractor).toBe('docx');
    expect(res.text).toContain('quarterly maintenance report');
    expect(res.text).not.toContain('<w:');
  });

  it('extracts cell values from .xlsx with sheet name headers', async () => {
    const p = writeFixture('sample.xlsx', buildMinimalXlsx([
      ['Part', 'Qty'],
      ['valve-actuator', 12]
    ]));
    const res = await extractContent(p);
    expect(res.status).toBe('extracted');
    expect(res.extractor).toBe('xlsx');
    expect(res.text).toContain('[Sheet1]');
    expect(res.text).toContain('valve-actuator');
    expect(res.text).toContain('12');
  });
});

describe('contentExtractor - caps and error paths', () => {
  it('skips files over the size cap without reading them', async () => {
    const p = writeFixture('big.txt', 'x'.repeat(1024));
    const res = await extractContent(p, { sizeCapBytes: 100 });
    expect(res.status).toBe('skipped_size');
    expect(res.text).toBeNull();
    expect(res.truncated).toBe(false);
  });

  it('truncates extracted text past truncateChars', async () => {
    const p = writeFixture('long.txt', 'abcdefghij'.repeat(100));
    const res = await extractContent(p, { truncateChars: 50 });
    expect(res.status).toBe('truncated');
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBe(50);
  });

  it('returns unsupported for unknown extensions', async () => {
    const p = writeFixture('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await extractContent(p);
    expect(res.status).toBe('unsupported');
    expect(res.extractor).toBeNull();
  });

  it('returns error status when the file does not exist', async () => {
    const res = await extractContent(path.join(tmpDir, 'missing.txt'));
    expect(res.status).toBe('error');
    expect(res.text).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it('returns error status for a corrupt rich-format file', async () => {
    const p = writeFixture('corrupt.docx', Buffer.from('this is not a zip'));
    const res = await extractContent(p);
    expect(res.status).toBe('error');
    expect(res.text).toBeNull();
  });
});
