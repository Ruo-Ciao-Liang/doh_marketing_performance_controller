import type { Suggestion } from "./rules-engine.ts";

export type ReviewDecision = "approved" | "rejected";

export type CellValue = string | number | null | undefined;
type CellStyle = "text" | "currency" | "percent" | "integer";

interface ExportColumn {
  title: string;
  width: number;
  style?: CellStyle;
  value: (suggestion: Suggestion, decision: ReviewDecision) => CellValue;
}

const recommendationLabels: Record<Suggestion["type"], string> = {
  increase: "Increase",
  reduce: "Reduce",
  hold: "Hold",
  pause_review: "Pause / review",
  harvest: "Harvest",
  harvest_review: "Exact conflict review",
  manual_review: "Manual review",
};

const columns: ExportColumn[] = [
  { title: "Review decision", width: 18, value: (_suggestion, decision) => decision === "approved" ? "Approved" : "Rejected" },
  { title: "Recommendation ID", width: 24, value: (suggestion) => suggestion.id },
  { title: "Recommendation", width: 20, value: (suggestion) => recommendationLabels[suggestion.type] },
  { title: "Priority", width: 11, style: "integer", value: (suggestion) => suggestion.priority },
  { title: "Confidence", width: 13, value: (suggestion) => suggestion.confidence },
  { title: "Product", width: 45, value: (suggestion) => suggestion.productName },
  { title: "SKU", width: 18, value: (suggestion) => suggestion.sku },
  { title: "ASIN", width: 16, value: (suggestion) => suggestion.asin },
  { title: "Campaign", width: 34, value: (suggestion) => suggestion.campaignName },
  { title: "Ad group", width: 28, value: (suggestion) => suggestion.adGroupName },
  { title: "Target", width: 32, value: (suggestion) => suggestion.target },
  { title: "Match type", width: 14, value: (suggestion) => suggestion.matchType },
  { title: "Current bid", width: 14, style: "currency", value: (suggestion) => suggestion.currentBid },
  { title: "Suggested bid", width: 14, style: "currency", value: (suggestion) => suggestion.suggestedBid },
  { title: "Bid change", width: 13, style: "percent", value: (suggestion) => suggestion.change },
  { title: "30-day spend", width: 15, style: "currency", value: (suggestion) => suggestion.spend },
  { title: "30-day sales", width: 15, style: "currency", value: (suggestion) => suggestion.sales },
  { title: "30-day orders", width: 15, style: "integer", value: (suggestion) => suggestion.purchases },
  { title: "30-day ACoS", width: 15, style: "percent", value: (suggestion) => suggestion.acos },
  { title: "Target ACoS", width: 15, style: "percent", value: (suggestion) => suggestion.targetAcos },
  { title: "Break-even ACoS", width: 18, style: "percent", value: (suggestion) => suggestion.breakEvenAcos },
  { title: "Maximum CPC", width: 15, style: "currency", value: (suggestion) => suggestion.maxCpc },
  { title: "Rule", width: 17, value: (suggestion) => suggestion.ruleId },
  { title: "Reason", width: 65, value: (suggestion) => suggestion.reason },
  { title: "Evidence", width: 65, value: (suggestion) => suggestion.evidence.join(" | ") },
  { title: "Risk / limitation", width: 65, value: (suggestion) => suggestion.risk },
  { title: "Harvest term", width: 32, value: (suggestion) => suggestion.harvestTerm },
  { title: "Destination campaign", width: 36, value: (suggestion) => suggestion.destinationCampaign },
  { title: "Destination is new", width: 19, value: (suggestion) => suggestion.destinationCampaignIsNew == null ? "" : suggestion.destinationCampaignIsNew ? "Yes" : "No" },
  { title: "Exact conflicts", width: 18, style: "integer", value: (suggestion) => suggestion.exactConflicts.length },
];

const xmlEscape = (value: CellValue) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const columnName = (index: number) => {
  let result = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};

const styleIndex = (style: CellStyle | undefined) => style === "currency" ? 2 : style === "percent" ? 3 : style === "integer" ? 4 : 0;

function cellXml(value: CellValue, row: number, column: number, style?: CellStyle, header = false) {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}" s="${header ? 1 : styleIndex(style)}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr" s="${header ? 1 : 0}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const uint16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

function joinBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zip(files: { name: string; content: string }[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const localHeader = joinBytes([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), name,
    ]);
    localParts.push(localHeader, content);

    centralParts.push(joinBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]));
    offset += localHeader.length + content.length;
  }

  const centralDirectory = joinBytes(centralParts);
  const end = joinBytes([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ]);
  return joinBytes([...localParts, centralDirectory, end]);
}

export function createTabularWorkbook(
  sheets: { name: string; rows: CellValue[][] }[],
  title: string,
  createdAt: string,
  headerFillRgb = "FF2468E8",
) {
  const safeSheets = sheets.map((sheet, index) => ({
    name: sheet.name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || `Sheet ${index + 1}`,
    rows: sheet.rows.length ? sheet.rows : [["No rows"]],
  }));
  const worksheetFiles = safeSheets.map((sheet, sheetIndex) => {
    const columnCount = Math.max(...sheet.rows.map((row) => row.length), 1);
    const rows = sheet.rows.map((row, rowIndex) =>
      `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => cellXml(value, rowIndex + 1, columnIndex, undefined, rowIndex === 0)).join("")}</row>`,
    ).join("");
    const lastColumn = columnName(columnCount - 1);
    const lastRow = Math.max(1, sheet.rows.length);
    return {
      name: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`,
    };
  });
  const worksheetTypes = safeSheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = safeSheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRelationships = safeSheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const stylesRelationshipId = safeSheets.length + 1;
  const created = new Date(createdAt).toISOString();
  return zip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheetTypes}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>Amazon Bidding Control</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>` },
    { name: "docProps/app.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Amazon Bidding Control</Application></Properties>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}<Relationship Id="rId${stylesRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${headerFillRgb}"/><bgColor rgb="${headerFillRgb}"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...worksheetFiles,
  ]);
}

export function reviewedSuggestionsFilename(reportEnd: string) {
  return `amazon-bidding-control-reviewed-${reportEnd}.xlsx`;
}

export function createReviewedSuggestionsWorkbook(
  suggestions: Suggestion[],
  decisions: Record<string, ReviewDecision>,
  reportEnd: string,
) {
  const reviewed = suggestions.filter((suggestion) => decisions[suggestion.id]);
  const header = `<row r="1" ht="22" customHeight="1">${columns.map((column, index) => cellXml(column.title, 1, index, undefined, true)).join("")}</row>`;
  const rows = reviewed.map((suggestion, rowIndex) => {
    const decision = decisions[suggestion.id];
    return `<row r="${rowIndex + 2}">${columns.map((column, columnIndex) => cellXml(column.value(suggestion, decision), rowIndex + 2, columnIndex, column.style)).join("")}</row>`;
  }).join("");
  const lastColumn = columnName(columns.length - 1);
  const lastRow = Math.max(1, reviewed.length + 1);
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join("")}</cols>
  <sheetData>${header}${rows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`;
  const created = `${reportEnd}T12:00:00Z`;

  return zip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Amazon Bidding Control reviewed suggestions</dc:title><dc:creator>Amazon Bidding Control</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>` },
    { name: "docProps/app.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Amazon Bidding Control</Application></Properties>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Reviewed suggestions" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="€#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2468E8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", content: worksheet },
  ]);
}
