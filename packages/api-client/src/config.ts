import type { CreateClientConfig } from "./generated/client.gen";

const DEFAULT_BASE_URL = "http://localhost:3000";

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL,
});
