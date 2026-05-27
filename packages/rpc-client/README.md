# @rockwarehq/rpc-client

Typed oRPC client for the Rockware API.

## Install

```bash
pnpm add @rockwarehq/rpc-client
```

## User-authenticated client

Use this for client apps calling user-protected procedures (for example, `events.stream`).

```ts
import { createRpcClient } from "@rockwarehq/rpc-client";

const client = createRpcClient({
  baseUrl: "http://localhost:30000",
  getToken: () => process.env.ACCESS_TOKEN,
});

const iterator = await client.events.stream({});
for await (const event of iterator) {
  console.log(event);
}
```

## Processor-authenticated client

Use this for processor services that call `events.ingest` with the shared secret.

```ts
import { createProcessorRpcClient } from "@rockwarehq/rpc-client";

const processorClient = createProcessorRpcClient({
  baseUrl: "http://localhost:30000",
  getSecret: () => process.env.PROCESSOR_SHARED_SECRET,
});

await processorClient.events.ingest({
  events: [
    {
      id: "310f1711-1514-4e22-a2e2-d0f6403db175",
      gatewayId: "6ce3a5ca-b72b-4879-b715-cfdbfdbe49b5",
      type: "PointValue",
      payload: {
        pointId: "2f0cd998-6fce-4431-9f3b-2f41526c84e4",
        valueRaw: 42,
        quality: "GOOD",
        timestamp: Date.now(),
        gatewayTimestamp: Date.now(),
      },
    },
  ],
});
```

## Exports

- `createRpcClient` - sends `Authorization: Bearer <token>`
- `createProcessorRpcClient` - sends `Authorization: Processor <secret>`
- `RpcClient`
- `AppRouter`
