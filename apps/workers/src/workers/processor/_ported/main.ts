import mqtt from "mqtt";
import { Pool } from "pg";

import { loadConfig } from "./config.ts";
import { startMetricsServer } from "./observability/metrics-server.ts";
import { createDispatcher } from "./pipeline/dispatcher.ts";
import { createMetrics, startMetricsReporter } from "./pipeline/metrics.ts";
import { parseMessage } from "./pipeline/parser.ts";
import { createPointsSplitEnricher } from "./pipeline/preprocessors/points-split-enricher.ts";
import type { EventPreprocessor, Logger } from "./pipeline/types.ts";
import { createProcessorRuntimeEntries } from "./processors/index.ts";
import { createStationEventsProcessor } from "./processors/station-events-processor.ts";
import { startStationEventsCacheRefreshServer } from "./station-events/cache-refresh-server.ts";
import { createPointSnapshotPreprocessor } from "./station-events/point-snapshot-preprocessor.ts";
import { createStationEventsRpcClient } from "./station-events/rpc-client.ts";
import { StationEventCache } from "./station-events/station-event-cache.ts";
import { TagSnapshotCache } from "./station-events/tag-snapshot-cache.ts";
import { hydrateMissingTagSnapshots } from "./station-events/tag-snapshot-loader.ts";

function createLogger(): Logger {
  return {
    debug(message, meta) {
      console.debug(message, meta ?? {});
    },
    info(message, meta) {
      console.info(message, meta ?? {});
    },
    warn(message, meta) {
      console.warn(message, meta ?? {});
    },
    error(message, meta) {
      console.error(message, meta ?? {});
    },
  };
}

function endClient(client: mqtt.MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(true, {}, () => resolve());
  });
}

export async function startListener(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  const metrics = createMetrics();
  const preprocessors: EventPreprocessor[] = [];
  let pointsEnrichmentPool: Pool | undefined;
  let stationEventsRefreshServer: Awaited<ReturnType<typeof startStationEventsCacheRefreshServer>> =
    null;
  let stationEventCache: StationEventCache | undefined;
  let stationEventsProcessor: ReturnType<typeof createStationEventsProcessor> | undefined;

  stationEventsRefreshServer = await startStationEventsCacheRefreshServer({
    config: config.stationEvents.cacheRefresh,
    logger,
    onRefresh: async (body) => {
      if (!stationEventCache) {
        logger.warn("station event cache refresh ignored because station events are disabled", {
          operation: body.operation,
          stationId: body.stationId,
          eventId: body.eventId,
        });
        throw new Error("station events are disabled");
      }

      await stationEventCache.refresh(`callback:${body.operation}`);
    },
  });

  if (config.stationEvents.enabled) {
    const stationEventsRpcClient = createStationEventsRpcClient({
      baseUrl: config.stationEvents.url,
      authToken: config.stationEvents.authToken,
    });

    stationEventCache = new StationEventCache({
      logger,
      rpcClient: stationEventsRpcClient,
    });
    const tagSnapshotCache = new TagSnapshotCache({
      maxEntries: config.stationEvents.tagSnapshotCacheMaxEntries,
    });

    await stationEventCache.loadInitialSnapshot();

    preprocessors.push(
      createPointSnapshotPreprocessor({
        tagSnapshotCache,
      }),
    );

    if (config.stationEvents.prewarmTagCache) {
      try {
        await hydrateMissingTagSnapshots({
          rpcClient: stationEventsRpcClient,
          tagSnapshotCache,
          tagKeys: stationEventCache.getAllRequiredKeys(),
          timeoutMs: config.stationEvents.timeoutMs,
          batchSize: config.stationEvents.tagFetchBatchSize,
          logger,
          reason: "station-event-startup-prewarm",
        });
      } catch (error) {
        logger.warn("station event tag prewarm failed", {
          cache: "tag-snapshots",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    stationEventsProcessor = createStationEventsProcessor({
      config: {
        timeoutMs: config.stationEvents.timeoutMs,
        tagFetchBatchSize: config.stationEvents.tagFetchBatchSize,
      },
      stationEventCache,
      tagSnapshotCache,
      rpcClient: stationEventsRpcClient,
      logger,
    });
  }

  if (config.pointsSplitEnrich.enabled) {
    pointsEnrichmentPool = new Pool({
      connectionString: config.dbEvents.connectionString,
    });
    preprocessors.push(
      createPointsSplitEnricher({
        queryClient: pointsEnrichmentPool,
        mode: config.pointsSplitEnrich.mode,
        logger,
      }),
    );

    logger.info("points split enrichment enabled", {
      mode: config.pointsSplitEnrich.mode,
    });
  } else {
    logger.info("points split enrichment disabled");
  }

  const entries = createProcessorRuntimeEntries({
    config,
    metrics,
    logger,
    stationEventsProcessor,
  });

  const dispatcher = createDispatcher({ entries, metrics, logger, preprocessors });
  const metricsServer = await startMetricsServer({
    config: config.metricsServer,
    logger,
  });
  const stopMetricsReporter = startMetricsReporter({
    metrics,
    logger,
    intervalMs: config.metricsIntervalMs,
  });

  const client = mqtt.connect(config.mqtt.brokerUrl, {
    username: config.mqtt.username,
    password: config.mqtt.password,
  });

  let intakeClosed = false;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    intakeClosed = true;

    logger.info("shutdown requested", { signal });

    await dispatcher.shutdown({ drainTimeoutMs: config.shutdownDrainTimeoutMs });
    if (pointsEnrichmentPool) {
      await pointsEnrichmentPool.end();
    }
    if (stationEventsRefreshServer) {
      await stationEventsRefreshServer.close();
    }
    await endClient(client);
    metrics.setServiceUp(0);
    if (metricsServer) {
      await metricsServer.close();
    }
    stopMetricsReporter();

    logger.info("shutdown complete");
  };

  client.on("connect", () => {
    logger.info("connected to mqtt broker", { brokerUrl: config.mqtt.brokerUrl });
    client.subscribe(config.mqtt.topic, (error) => {
      if (error) {
        logger.error("failed to subscribe", {
          topic: config.mqtt.topic,
          error: error.message,
        });
        return;
      }

      logger.info("subscribed", { topic: config.mqtt.topic });
    });
  });

  client.on("message", (topic, raw) => {
    if (intakeClosed) {
      return;
    }

    const receivedAt = Date.now();
    const parsed = parseMessage({ topic, raw, receivedAt });

    if (parsed.isErr()) {
      metrics.incParseError();
      logger.warn("message rejected by parser", {
        topic,
        code: parsed.error.code,
        message: parsed.error.message,
      });
      return;
    }

    metrics.incParsedOk();

    void dispatcher.dispatch(parsed.value).catch((error) => {
      logger.error("dispatch failed", {
        topic,
        eventId: parsed.value.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.on("error", (error: Error) => {
    logger.error("mqtt client error", { error: error.message });
  });

  client.on("close", () => {
    logger.info("mqtt connection closed");
  });

  client.on("offline", () => {
    logger.warn("mqtt client offline");
  });

  client.on("reconnect", () => {
    logger.info("mqtt reconnecting");
  });

  await new Promise<void>((resolve, reject) => {
    const onSignal = async (signal: string) => {
      try {
        await shutdown(signal);
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    process.once("SIGINT", () => {
      void onSignal("SIGINT");
    });
    process.once("SIGTERM", () => {
      void onSignal("SIGTERM");
    });
  });
}
