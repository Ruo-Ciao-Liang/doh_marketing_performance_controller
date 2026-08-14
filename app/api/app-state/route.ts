import { getChatGPTUser } from "../../chatgpt-auth";
import type { RuleSettings } from "../../../lib/collaboration-storage.ts";

function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : "Unexpected persistence error.";
  const conflict = error && typeof error === "object" && "current" in error ? (error as { current: unknown }).current : undefined;
  return Response.json({ error: message, current: conflict }, { status });
}

function validSettings(value: unknown): value is RuleSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<RuleSettings>;
  return typeof settings.aggressivenessFactor === "number" &&
    settings.aggressivenessFactor >= 0.5 && settings.aggressivenessFactor <= 1 &&
    typeof settings.maxBidChange === "number" &&
    settings.maxBidChange >= 0.05 && settings.maxBidChange <= 0.3 &&
    Number.isInteger(settings.minimumClicks) &&
    Number(settings.minimumClicks) >= 3 && Number(settings.minimumClicks) <= 20 &&
    validPolicy(settings.policy);
}

function validPolicy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const numberIn = (key: string, minimum: number, maximum: number) =>
    typeof policy[key] === "number" && Number.isFinite(policy[key]) &&
    Number(policy[key]) >= minimum && Number(policy[key]) <= maximum;
  const integerIn = (key: string, minimum: number, maximum: number) =>
    numberIn(key, minimum, maximum) && Number.isInteger(policy[key]);
  if (!numberIn("zeroEarlyThreshold", 0.25, 2) ||
      !numberIn("zeroTargetThreshold", 0.5, 2.5) ||
      !numberIn("zeroPauseThreshold", 0.75, 3) ||
      !(Number(policy.zeroEarlyThreshold) < Number(policy.zeroTargetThreshold) &&
        Number(policy.zeroTargetThreshold) < Number(policy.zeroPauseThreshold))) return false;
  if (!numberIn("strongScaleThreshold", 0.2, 1) ||
      !numberIn("moderateScaleThreshold", 0.3, 1.2) ||
      !numberIn("holdThreshold", 0.5, 1.5) ||
      !numberIn("lightReductionThreshold", 0.75, 2) ||
      !numberIn("mediumReductionThreshold", 1, 3) ||
      !(Number(policy.strongScaleThreshold) < Number(policy.moderateScaleThreshold) &&
        Number(policy.moderateScaleThreshold) < Number(policy.holdThreshold) &&
        Number(policy.holdThreshold) < Number(policy.lightReductionThreshold) &&
        Number(policy.lightReductionThreshold) < Number(policy.mediumReductionThreshold))) return false;
  return [
    "zeroEarlyReduction", "zeroTargetReduction", "strongScaleIncrease",
    "moderateScaleIncrease", "lightReduction", "mediumReduction", "highReduction",
  ].every((key) => numberIn(key, 0.01, 0.3)) &&
    integerIn("strongScaleMinimumPurchases", 1, 10) &&
    integerIn("moderateScaleMinimumPurchases", 1, 10) &&
    integerIn("harvestMinimumPurchases", 1, 10) &&
    numberIn("harvestBidBuffer", 1, 1.5);
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to load saved organization state." }, { status: 401 });
  try {
    const snapshotId = new URL(request.url).searchParams.get("snapshotId");
    if (!snapshotId) return errorResponse(new Error("A snapshot ID is required."), 400);
    const { getCollaborationState } = await import("../../../lib/collaboration-storage.ts");
    return Response.json({ user, ...(await getCollaborationState(user.email, snapshotId)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to save changes." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const storage = await import("../../../lib/collaboration-storage.ts");
    if (body.type === "settings") {
      if (!validSettings(body.value) || !Number.isInteger(body.expectedRevision)) {
        return errorResponse(new Error("The rule settings or revision are invalid."), 400);
      }
      return Response.json({ saved: await storage.saveOrganizationSettings(body.value, Number(body.expectedRevision), user.email) });
    }
    if (body.type === "review") {
      const decision = body.decision;
      if (typeof body.snapshotId !== "string" || typeof body.suggestionId !== "string" ||
          (decision !== "approved" && decision !== "rejected" && decision !== null) ||
          !Number.isInteger(body.expectedRevision)) {
        return errorResponse(new Error("The review decision is invalid."), 400);
      }
      return Response.json({ saved: await storage.saveReviewDecision({
        snapshotId: body.snapshotId,
        suggestionId: body.suggestionId,
        decision,
        expectedRevision: Number(body.expectedRevision),
        userEmail: user.email,
      }) });
    }
    if (body.type === "preferences") {
      if (!body.value || typeof body.value !== "object" || Array.isArray(body.value) ||
          JSON.stringify(body.value).length > 10_000 || !Number.isInteger(body.expectedRevision)) {
        return errorResponse(new Error("The saved view preferences are invalid or too large."), 400);
      }
      return Response.json({ saved: await storage.saveUserPreferences(
        body.value as Record<string, unknown>,
        Number(body.expectedRevision),
        user.email,
      ) });
    }
    return errorResponse(new Error("Unsupported persistence action."), 400);
  } catch (error) {
    const isConflict = error && typeof error === "object" && "current" in error;
    return errorResponse(error, isConflict ? 409 : 500);
  }
}
