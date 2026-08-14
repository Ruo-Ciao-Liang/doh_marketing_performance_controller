import { getChatGPTUser } from "../../../chatgpt-auth";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;

function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : "Unexpected upload error.";
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to import data." }, { status: 401 });
  try {
    const form = await request.formData();
    const chunk = form.get("chunk");
    const uploadId = String(form.get("uploadId") ?? "");
    const fileId = String(form.get("fileId") ?? "");
    const fileName = String(form.get("fileName") ?? "");
    const fileSize = Number(form.get("fileSize"));
    const chunkIndex = Number(form.get("chunkIndex"));
    const chunkCount = Number(form.get("chunkCount"));
    if (!(chunk instanceof File)) throw new Error("One upload chunk is missing.");
    if (!fileName.toLowerCase().endsWith(".csv")) throw new Error(`${fileName || "The selected file"} is not a CSV file.`);
    if (!Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_FILE_BYTES) {
      throw new Error(`${fileName} is larger than the supported 8 MB per-file limit.`);
    }
    if (chunk.size > MAX_CHUNK_BYTES) throw new Error("One upload chunk is larger than 512 KB.");
    const { stageImportChunk } = await import("../../../../lib/snapshot-storage.ts");
    await stageImportChunk({
      uploadId,
      fileId,
      chunk: await chunk.arrayBuffer(),
      chunkIndex,
      chunkCount,
      fileName,
      fileSize,
      createdBy: user.email,
    });
    return Response.json({ fileId, fileName, chunkIndex, chunkCount }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to manage an upload." }, { status: 401 });
  try {
    const payload = await request.json() as { uploadId?: string; fileIds?: string[] };
    const { deleteStagedImportFiles } = await import("../../../../lib/snapshot-storage.ts");
    await deleteStagedImportFiles(payload.uploadId ?? "", payload.fileIds ?? [], user.email);
    return Response.json({ deleted: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
