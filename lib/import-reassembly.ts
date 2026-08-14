export async function collectImportChunksSequentially<T>(
  chunkCount: number,
  readChunk: (chunkIndex: number) => Promise<T>,
): Promise<T[]> {
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error("The file chunk sequence is invalid.");
  }
  const chunks: T[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    chunks.push(await readChunk(chunkIndex));
  }
  return chunks;
}
