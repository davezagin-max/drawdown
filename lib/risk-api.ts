/**
 * Browser-side access to the Python risk API (server/). Only uploaded holdings and
 * live analyst runs go there; the sample portfolio is bundled with this app.
 */
import { callApi } from "./client";
import { PortfolioResponse } from "./schema";

/** Empty when this deployment has no risk API attached. `pnpm dev` assumes the local one. */
export const RISK_API_URL = (
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:8300" : "")
).replace(/\/+$/, "");

export const hasRiskApi = RISK_API_URL !== "";

export type UploadResult = { ok: true; data: PortfolioResponse } | { ok: false; message: string };

const UNREACHABLE =
  "The risk engine API did not answer. It may be asleep or offline. The sample portfolio still works.";

export async function analyzeCsv(csv: string, signal?: AbortSignal): Promise<UploadResult> {
  if (!hasRiskApi) {
    return { ok: false, message: "This deployment is not connected to the risk engine API." };
  }
  const response = await callApi<unknown>(`${RISK_API_URL}/api/portfolio`, { csv }, null, signal);
  if (!response.ok) {
    // `callApi` reports a failed fetch as a generic network error.
    const offline = response.error.message.startsWith("Network error");
    return { ok: false, message: offline ? UNREACHABLE : response.error.message };
  }
  const parsed = PortfolioResponse.safeParse(response.data);
  if (!parsed.success) {
    return { ok: false, message: "The risk engine returned data this page does not understand." };
  }
  return { ok: true, data: parsed.data };
}
