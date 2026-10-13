// A route service owns a set of contract paths. The API server validates the request against the
// contract, then hands it over; the service does authorization, body parsing and the use case.
export interface ServiceRequest {
  method: "GET" | "POST";
  path: string; // contract path, e.g. "/v1/markets/:id"
  params: Record<string, string>; // validated + lowercased hex where the contract uses Address/Hash
  query: Record<string, unknown>; // parsed with the contract query schema (coerced)
  body: unknown; // raw; services parse with the contract body schema
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  requestId: string;
  ip: string;
}
export interface ServiceResponse {
  status: number;
  body: Record<string, unknown> | Uint8Array;
  contentType?: string; // default application/json
  headers?: Record<string, string>; // e.g. Cache-Control, ETag, Retry-After
}
export interface RouteService {
  readonly paths: readonly string[]; // exact apiContracts paths
  handle(request: ServiceRequest): Promise<ServiceResponse>;
}
