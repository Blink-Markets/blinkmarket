import {
  ApiError,
  ConfigResponse,
  RfqRequest,
  SignedQuoteResponse,
  apiContracts,
  type PublicMarketRef,
} from "@blink/schemas";

export class BlinkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message);
  }
}
export function createBlinkClient(baseUrl: string, apiKey?: string) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    )
  )
    throw new Error("HTTPS_REQUIRED");
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(new URL(path, base), {
      ...init,
      redirect: "error",
      headers: {
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
        ...init.headers,
      },
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new BlinkApiError(response.status, ApiError.parse(body));
    return body;
  }
  return {
    async getConfig() {
      return ConfigResponse.parse(await request("/v1/config"));
    },
    async getMarket(ref: PublicMarketRef) {
      const contract = apiContracts.find(
        (c) => c.path === "/v1/markets/:id" && c.method === "GET",
      )!;
      const params = contract.params.parse({ id: ref.marketId });
      const query = contract.query.parse({ deploymentId: ref.deploymentId });
      return contract.response.parse(
        await request(
          "/v1/markets/" +
            params["id"] +
            "?" +
            new URLSearchParams(query as Record<string, string>),
        ),
      );
    },
    async requestQuote(input: unknown, idempotencyKey: string) {
      const body = RfqRequest.parse(input);
      return SignedQuoteResponse.parse(
        await request("/v1/rfqs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
export type { MarketRef as PublicMarketRef } from "@blink/schemas";
