// Flattens an OpenAPI document into a list for the /docs/api index.
export type ApiOperation = {
  method: string;
  path: string;
  group: string;
  status: string;
  access: string | null;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function groupOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] === "v1" ? segments[1] : segments[0];
  return first ?? "root";
}

export function indexOpenApi(doc: unknown): ApiOperation[] {
  const paths = (doc as { paths?: unknown } | null)?.paths;
  if (!paths || typeof paths !== "object") return [];
  const ops: ApiOperation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, Record<string, unknown>>)) {
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const status = op["x-status"];
      const access = op["x-planned-access"];
      ops.push({
        method: method.toUpperCase(),
        path,
        group: groupOf(path),
        status: typeof status === "string" ? status : "unspecified",
        access: typeof access === "string" ? access : null,
      });
    }
  }
  return ops.sort(
    (a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

export function groupOperations(ops: readonly ApiOperation[]): { group: string; operations: ApiOperation[] }[] {
  const groups = new Map<string, ApiOperation[]>();
  for (const op of ops) {
    const list = groups.get(op.group) ?? [];
    list.push(op);
    groups.set(op.group, list);
  }
  return [...groups].map(([group, operations]) => ({ group, operations }));
}
