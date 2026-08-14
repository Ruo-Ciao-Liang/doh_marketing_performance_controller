import { getChatGPTUser } from "../../chatgpt-auth";

function validDate(value: string | null): value is string { return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)); }

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in to compare marketplace performance." }, { status: 401 });
  const search = new URL(request.url).searchParams; const start = search.get("start"); const end = search.get("end");
  if (!validDate(start) || !validDate(end) || start > end) return Response.json({ error: "Choose a valid aligned From and To date." }, { status: 400 });
  try {
    const { getAlignedComparisonRows } = await import("../../../lib/marketplace-comparison-storage.ts");
    const rows = await getAlignedComparisonRows(start, end);
    return Response.json({ start, end, rows, generatedAt: new Date().toISOString() });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Marketplace comparison failed." }, { status: 500 }); }
}
