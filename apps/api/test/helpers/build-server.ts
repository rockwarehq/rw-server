import { createServer } from "../../src/server.js";

export function buildServer(options?: { swagger?: boolean }) {
  const { server } = createServer({
    port: 0,
    host: "127.0.0.1",
    graceDelay: 500,
    swagger: options?.swagger ?? false,
    installShutdownHandlers: false,
  });
  return server;
}

export type TestServer = ReturnType<typeof buildServer>;

export async function loginAs(server: TestServer, email: string, password: string) {
  const response = await server.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`);
  }
  return response.json() as { accessToken: string; refreshToken: string };
}
