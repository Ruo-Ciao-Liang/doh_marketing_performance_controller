import { getChatGPTUser } from "../../chatgpt-auth";
import { marketplaceIds, marketplaceRegistry } from "../../../lib/marketplaces.ts";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in to view marketplaces." }, { status: 401 });
  return Response.json({ marketplaces: marketplaceIds.map((id) => marketplaceRegistry[id]) });
}

