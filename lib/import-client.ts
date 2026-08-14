export interface ImportApiPayload {
  error?: string;
  [key: string]: unknown;
}

export const IMPORT_CHUNK_BYTES = 256 * 1024;

export interface ImportChunkRange {
  index: number;
  count: number;
  start: number;
  end: number;
}

export function importChunkRanges(fileSize: number, chunkSize = IMPORT_CHUNK_BYTES): ImportChunkRange[] {
  if (!Number.isInteger(fileSize) || fileSize < 1 || !Number.isInteger(chunkSize) || chunkSize < 1) return [];
  const count = Math.ceil(fileSize / chunkSize);
  return Array.from({ length: count }, (_value, index) => ({
    index,
    count,
    start: index * chunkSize,
    end: Math.min(fileSize, (index + 1) * chunkSize),
  }));
}

export function parseImportApiPayload(text: string, status: number): ImportApiPayload {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: status >= 400 ? `The upload service returned an empty error response (${status}).` : undefined };
  }
  try {
    return JSON.parse(trimmed) as ImportApiPayload;
  } catch {
    if (status === 413 || /payload too large|request entity too large/i.test(trimmed)) {
      return { error: "One upload chunk was rejected as too large. Refresh the page and retry with the latest uploader." };
    }
    return { error: status >= 400 ? `The upload service rejected the request (${status}). Please retry.` : "The upload service returned an unreadable response." };
  }
}
