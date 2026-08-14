import baseSnapshotJson from "../../../data/generated/normalized.json";
import { getChatGPTUser } from "../../chatgpt-auth";
import { normalizeRuntimeImport, type UploadFileInput } from "../../../lib/runtime-import.ts";
import { getMarketplaceDefinition, normalizeMarketplaceId } from "../../../lib/marketplaces.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : "Unexpected import error.";
  return Response.json({ error: message }, { status });
}

function validateFileCount(count: number, marketplaceId: ReturnType<typeof normalizeMarketplaceId>) {
  const requirements = getMarketplaceDefinition(marketplaceId).importRequirements;
  const minimum = requirements.filter((item) => !item.optional).length;
  const maximum = requirements.length;
  if (count < minimum || count > maximum) {
    const range = minimum === maximum ? `${minimum} required files` : `${minimum} required files and up to ${maximum - minimum} optional file${maximum - minimum === 1 ? "" : "s"}`;
    throw new Error(`Choose the ${range} for ${getMarketplaceDefinition(marketplaceId).name}. ${count} files were received.`);
  }
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to view persistent import history." }, { status: 401 });
  const search = new URL(request.url).searchParams;
  try {
    const { getAdvertisingRange, getSnapshot } = await import("../../../lib/snapshot-storage.ts");
    const marketplaceId = normalizeMarketplaceId(search.get("marketplaceId"));
    const advertisingStart = search.get("advertisingStart");
    const advertisingEnd = search.get("advertisingEnd");
    if (advertisingStart || advertisingEnd) {
      if (!advertisingStart || !advertisingEnd) return errorResponse(new Error("Choose both From and To dates."), 400);
      return Response.json({ advertisingRange: await getAdvertisingRange(advertisingStart, advertisingEnd, marketplaceId) });
    }
    const snapshotId = search.get("id") ?? undefined;
    return Response.json(await getSnapshot(snapshotId, marketplaceId));
  } catch (error) {
    return errorResponse(error, search.has("advertisingStart") || search.has("advertisingEnd") ? 400 : 500);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to import data." }, { status: 401 });
  let stagedUpload: { uploadId: string; fileIds: string[] } | null = null;
  let marketplaceId = normalizeMarketplaceId(undefined);
  try {
    const {
      findSnapshotBySourceHash,
      getSnapshot,
      readSnapshotImportFiles,
      readStagedImportFiles,
      saveSnapshot,
      sourceSetHash,
    } = await import("../../../lib/snapshot-storage.ts");
    let rawFiles: UploadFileInput[];
    let reprocessSnapshotId = "";
    if (request.headers.get("content-type")?.includes("application/json")) {
      const payload = await request.json() as { uploadId?: string; fileIds?: string[]; marketplaceId?: string; reprocessSnapshotId?: string };
      marketplaceId = normalizeMarketplaceId(payload.marketplaceId);
      reprocessSnapshotId = payload.reprocessSnapshotId?.trim() ?? "";
      if (reprocessSnapshotId) {
        rawFiles = await readSnapshotImportFiles(reprocessSnapshotId, marketplaceId);
        validateFileCount(rawFiles.length, marketplaceId);
      } else {
        const uploadId = payload.uploadId ?? "";
        const fileIds = payload.fileIds ?? [];
        stagedUpload = { uploadId, fileIds };
        validateFileCount(fileIds.length, marketplaceId);
        if (new Set(fileIds).size !== fileIds.length) {
          return errorResponse(new Error("The staged upload contains a duplicate file reference."), 400);
        }
        rawFiles = await readStagedImportFiles(uploadId, fileIds, user.email);
      }
    } else {
      const form = await request.formData();
      marketplaceId = normalizeMarketplaceId(String(form.get("marketplaceId") ?? "amazon_de"));
      const selected = form.getAll("files").filter((value): value is File => value instanceof File);
      validateFileCount(selected.length, marketplaceId);
      rawFiles = await Promise.all(selected.map(async (file) => {
        const text = await file.text();
        return { name: file.name, size: file.size, text, sha256: await hashText(text) };
      }));
    }
    const totalBytes = rawFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return errorResponse(new Error("The combined upload is larger than 60 MB."), 400);
    if (rawFiles.some((file) => file.size > MAX_FILE_BYTES)) return errorResponse(new Error("Each CSV file must be 8 MB or smaller."), 400);
    const snapshotId = crypto.randomUUID();
    const normalized = marketplaceId === "kaufland_de"
      ? await (async () => {
          const { normalizeKauflandImport } = await import("../../../lib/kaufland-import.ts");
          const storage = await import("../../../lib/marketplace-storage.ts");
          return normalizeKauflandImport({
            files: rawFiles,
            baseSnapshot: baseSnapshotJson as unknown as Parameters<typeof normalizeKauflandImport>[0]["baseSnapshot"],
            snapshotId,
            identifiers: await storage.listProductIdentifiers(marketplaceId),
            costSettings: await storage.getMarketplaceSettings(marketplaceId),
          });
        })()
      : normalizeRuntimeImport(rawFiles, baseSnapshotJson as unknown as Parameters<typeof normalizeRuntimeImport>[1], snapshotId);
    if (reprocessSnapshotId) {
      normalized.snapshot.reprocessing = {
        sourceSnapshotId: reprocessSnapshotId,
        productMasterSha256: ((normalized.snapshot as { imports?: Array<{ key?: string; sha256?: string }> }).imports ?? [])
          .find((item) => item.key === "product_master")?.sha256 ?? null,
        reprocessedAt: new Date().toISOString(),
        reprocessedBy: user.email,
      };
    }
    const fixedSourceKeys = new Set(["product_master", "amazon_listing", "economics"]);
    const fixedSources = ((normalized.snapshot as { imports?: Array<{ key?: string; sha256?: string }> }).imports ?? [])
      .filter((item) => item.key && item.sha256 && fixedSourceKeys.has(item.key))
      .map((item) => ({ role: `fixed:${item.key}`, sha256: item.sha256! }));
    const hash = await sourceSetHash([...normalized.files, ...fixedSources]);
    const duplicate = await findSnapshotBySourceHash(hash, marketplaceId);
    if (duplicate) {
      return Response.json({
        error: reprocessSnapshotId
          ? `This retained period has already been processed with the current product master. Snapshot ${duplicate.periodStart} to ${duplicate.periodEnd} remains unchanged.`
          : `These exact source files were already imported with the current fixed product sources for ${duplicate.periodStart} to ${duplicate.periodEnd}. The existing snapshot was kept unchanged.`,
        duplicate,
      }, { status: 409 });
    }
    const saved = await saveSnapshot({
      id: snapshotId,
      createdBy: user.email,
      snapshot: normalized.snapshot,
      status: normalized.validation.status,
      warnings: normalized.validation.warnings,
      sourceHash: hash,
      rawFiles,
      classifiedFiles: normalized.files,
    });
    const latest = await getSnapshot(undefined, marketplaceId);
    return Response.json({
      snapshot: latest.snapshot,
      summary: latest.summary,
      history: latest.history,
      importedSummary: saved.summary,
      validation: normalized.validation,
      reprocessedFromSnapshotId: reprocessSnapshotId || undefined,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  } finally {
    if (stagedUpload) {
      try {
        const { deleteStagedImportFiles } = await import("../../../lib/snapshot-storage.ts");
        await deleteStagedImportFiles(stagedUpload.uploadId, stagedUpload.fileIds, user.email);
      } catch {
        // Staging cleanup must not replace the actual import result.
      }
    }
  }
}
