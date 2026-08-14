// Zero-dependency, browser-side workbook reader shared by the client-side importers
// (product master and Allegro). Reads every worksheet of an .xlsx (ZIP + shared
// strings + inline strings, inflating DEFLATE entries with the platform's native
// DecompressionStream) and parses delimited text (.csv/.tsv) with delimiter
// detection. No file ever leaves the browser.

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

// Accepts both German/Polish ("1 234,56" / "1.234,56") and English ("1,234.56")
// numeric conventions, plus stray currency symbols and spaces.
export function parseLocaleNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  text = text.replace(/[€$£zł\s ]/gi, "").replace(/%/g, "");
  if (!text || text === "-") return null;
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (hasComma) {
    text = text.replace(/\./g, "").replace(",", ".");
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// Excel serial date (days since 1899-12-30) → ISO yyyy-mm-dd. Fractions (time of
// day) are dropped. Also passes through values that are already ISO dates.
export function excelSerialToISO(raw: string | number | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const serial = Number(text);
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(serial) * 86400000);
  return date.toISOString().slice(0, 10);
}

// Turn a sheet's rows into header-keyed objects. The header row defaults to the
// first row with more than one non-empty cell (Allegro reports prefix a title row).
export function sheetToObjects(rows: string[][], headerRowIndex?: number): Record<string, string>[] {
  if (!rows.length) return [];
  const index = headerRowIndex ?? rows.findIndex((row) => row && row.filter((cell) => (cell ?? "").trim()).length > 1);
  const headerRow = index >= 0 ? index : 0;
  const headers = (rows[headerRow] ?? []).map((header) => (header ?? "").trim());
  return rows.slice(headerRow + 1).map((cells) => {
    const object: Record<string, string> = {};
    headers.forEach((header, columnIndex) => { if (header) object[header] = (cells[columnIndex] ?? "").trim(); });
    return object;
  });
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(clean);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field); field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((cell) => cell.length > 0) || record.length > 1) records.push(record);
      record = [];
    } else field += char;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

// ---------------------------------------------------------------------------
// XLSX (ZIP container + inflate + shared strings + every worksheet)
// ---------------------------------------------------------------------------

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer: ArrayBuffer): Promise<Record<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file is not a valid .xlsx workbook (missing ZIP end record).");
  const entryCount = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const files: Record<string, Uint8Array> = {};
  const decoder = new TextDecoder();
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    files[name] = method === 0 ? compressed : await inflateRaw(compressed);
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml))) {
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = "";
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(siMatch[1]))) text += decodeXmlEntities(tMatch[1]);
    strings.push(text);
  }
  return strings;
}

function columnToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "");
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function parseWorksheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(xml))) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    let autoColumn = 0;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const columnIndex = refMatch ? columnToIndex(refMatch[1]) : autoColumn;
      autoColumn = columnIndex + 1;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = raw != null ? (shared[Number(raw)] ?? "") : "";
      } else if (type === "inlineStr") {
        const raw = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
        value = raw != null ? decodeXmlEntities(raw) : "";
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = raw != null ? decodeXmlEntities(raw) : "";
      }
      cells[columnIndex] = value;
    }
    rows.push(cells);
  }
  return rows;
}

async function readXlsxSheets(buffer: ArrayBuffer): Promise<WorkbookSheet[]> {
  const files = await unzip(buffer);
  const decoder = new TextDecoder();
  const textOf = (name: string) => (files[name] ? decoder.decode(files[name]) : "");
  const shared = parseSharedStrings(textOf("xl/sharedStrings.xml"));
  const workbookXml = textOf("xl/workbook.xml");
  const relsXml = textOf("xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/?>/g)) {
    relMap.set(rel[1], rel[2].replace(/^\//, "").replace(/^xl\//, ""));
  }
  const sheetTags = [...workbookXml.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*\/?>/g)];
  const fallback = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  const targets = sheetTags.length
    ? sheetTags.map((tag) => ({ name: decodeXmlEntities(tag[1]), file: `xl/${relMap.get(tag[2]) ?? ""}` }))
    : fallback.map((file, index) => ({ name: `Sheet${index + 1}`, file }));
  return targets
    .filter((target) => files[target.file])
    .map((target) => ({ name: target.name, rows: parseWorksheet(textOf(target.file), shared) }));
}

export async function readWorkbookFile(file: File): Promise<WorkbookSheet[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx")) return readXlsxSheets(await file.arrayBuffer());
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    return [{ name: "Sheet1", rows: parseDelimited(await file.text()) }];
  }
  throw new Error("Unsupported file type. Upload an .xlsx or .csv file.");
}
