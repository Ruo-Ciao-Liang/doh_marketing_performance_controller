import baseSnapshotJson from "../../../data/generated/normalized.json";
import { getChatGPTUser } from "../../chatgpt-auth";
import { normalizeMarketplaceId } from "../../../lib/marketplaces.ts";

function errorResponse(error: unknown, status = 500): Response {
  return Response.json({ error: error instanceof Error ? error.message : "Unexpected marketplace configuration error." }, { status });
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return errorResponse(new Error("Sign in to view marketplace configuration."), 401);
  try {
    const marketplaceId = normalizeMarketplaceId(new URL(request.url).searchParams.get("marketplaceId"));
    const storage = await import("../../../lib/marketplace-storage.ts");
    return Response.json({
      marketplaceId,
      identifiers: await storage.listProductIdentifiers(marketplaceId),
      settings: await storage.getMarketplaceSettings(marketplaceId),
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return errorResponse(new Error("Sign in to update marketplace configuration."), 401);
  try {
    const form = await request.formData();
    const marketplaceId = normalizeMarketplaceId(String(form.get("marketplaceId") || "kaufland_de"));
    const file = form.get("mapping");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) return errorResponse(new Error("Choose a CSV mapping file."), 400);
    if (file.size > 2 * 1024 * 1024) return errorResponse(new Error("The mapping file must be 2 MB or smaller."), 400);
    const text = await file.text();
    const catalogProducts = (baseSnapshotJson.catalogProducts as Array<{ sku: string }> | undefined)
      ?? (baseSnapshotJson.products as Array<{ sku: string }>);
    const validSkus = new Set(catalogProducts.map((product) => product.sku));
    const storage = await import("../../../lib/marketplace-storage.ts");
    return Response.json(await storage.saveProductIdentifierMapping({ marketplaceId, fileName: file.name, text, sha256: await hashText(text), createdBy: user.email, validSkus }), { status: 201 });
  } catch (error) { return errorResponse(error, 400); }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return errorResponse(new Error("Sign in to update marketplace settings."), 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const marketplaceId = normalizeMarketplaceId(String(body.marketplaceId));
    const storage = await import("../../../lib/marketplace-storage.ts");
    const current = await storage.getMarketplaceSettings(marketplaceId);
    return Response.json(await storage.saveMarketplaceSettings({
      ...current,
      marketplaceId,
      commissionRate: body.commissionRate == null ? null : Number(body.commissionRate),
      vatRate: Number(body.vatRate),
      confirmed: Boolean(body.confirmed),
      categoryOverrides: body.categoryOverrides && typeof body.categoryOverrides === "object" ? body.categoryOverrides as Record<string, number> : {},
    }, Number(body.expectedRevision), user.email));
  } catch (error) { return errorResponse(error, 409); }
}
