/**
 * Health endpoints (D61/D71, AC9): `healthCheck` (liveness) and `readyCheck`
 * (readiness — pings the store) return `{ status, body }`; tests call the
 * check functions directly. `createHealthServer` wires them to a plain HTTP
 * server for production (`/health` and `/ready`).
 */
import { createServer, type Server } from "node:http";
import type { Store } from "./store/types.js";

export interface HealthDeps {
  store: Store;
  version?: string;
}

export interface HealthResponse {
  status: number;
  body: string;
}

/** Liveness: the process is up and can answer. */
export async function healthCheck(deps: HealthDeps): Promise<HealthResponse> {
  const version = deps.version ?? "0.0.0";
  return { status: 200, body: JSON.stringify({ status: "ok", version }) };
}

/** Readiness: the database (store) answers its ping. */
export async function readyCheck(deps: HealthDeps): Promise<HealthResponse> {
  try {
    await deps.store.ping();
    const version = deps.version ?? "0.0.0";
    return { status: 200, body: JSON.stringify({ status: "ready", version }) };
  } catch {
    return { status: 503, body: JSON.stringify({ status: "unavailable" }) };
  }
}

/** Production wiring: serves /health and /ready on the given port. */
export function createHealthServer(deps: HealthDeps, port = 8080): Server {
  const server = createServer((req, res) => {
    const answer = (response: HealthResponse): void => {
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(response.body);
    };
    if (req.url === "/health") {
      void healthCheck(deps).then(answer);
      return;
    }
    if (req.url === "/ready") {
      void readyCheck(deps).then(answer);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });
  server.listen(port);
  return server;
}
