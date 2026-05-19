import { Pool } from "pg";

import type { AppConfig } from "../config.ts";
import { createBoundedRuntime } from "../pipeline/runtime/bounded-runtime.ts";
import type {
  Logger,
  Metrics,
  Processor,
  ProcessorRuntime,
  ProcessorRuntimeConfig,
  ProcessorRuntimeEntry,
} from "../pipeline/types.ts";
import { consoleProcessor } from "./console-processor.ts";
import { createDbEventsProcessor } from "./db-events-processor.ts";
import { createFileEventsProcessor } from "./file-events-processor.ts";
import { createHttpEventsProcessor } from "./http-events-processor.ts";
import { createUniqueTopicsProcessor } from "./unique-topics-processor.ts";

function mergeRuntimeConfig(
  base: ProcessorRuntimeConfig,
  override?: Partial<ProcessorRuntimeConfig>,
): ProcessorRuntimeConfig {
  return {
    concurrency: override?.concurrency ?? base.concurrency,
    queueCapacity: override?.queueCapacity ?? base.queueCapacity,
    overflow: override?.overflow ?? base.overflow,
    processTimeoutMs: override?.processTimeoutMs ?? base.processTimeoutMs,
  };
}

function withShutdownHook(args: {
  runtime: ProcessorRuntime;
  shutdownHook: () => Promise<void>;
  logger: Logger;
}): ProcessorRuntime {
  return {
    processor: args.runtime.processor,
    submit(event) {
      return args.runtime.submit(event);
    },
    snapshot() {
      return args.runtime.snapshot();
    },
    async shutdown(options) {
      await args.runtime.shutdown(options);
      try {
        await args.shutdownHook();
      } catch (error) {
        args.logger.error("processor shutdown hook failed", {
          processor: args.runtime.processor.name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export function createProcessorRuntimeEntries(args: {
  config: AppConfig;
  metrics: Metrics;
  logger: Logger;
  stationEventsProcessor?: Processor;
}): ProcessorRuntimeEntry[] {
  const common = {
    metrics: args.metrics,
    logger: args.logger,
  };

  const entries: ProcessorRuntimeEntry[] = [];

  if (args.config.consoleEvents.enabled) {
    const consoleRuntimeConfig = mergeRuntimeConfig(args.config.processorDefaults);
    const consoleRuntime = createBoundedRuntime({
      processor: consoleProcessor,
      config: consoleRuntimeConfig,
      ...common,
    });

    entries.push({ processor: consoleProcessor, runtime: consoleRuntime });
  }

  if (args.stationEventsProcessor) {
    const stationEventsRuntime = createBoundedRuntime({
      processor: args.stationEventsProcessor,
      config: mergeRuntimeConfig(args.config.processorDefaults, args.config.stationEvents.runtime),
      ...common,
    });

    entries.push({ processor: args.stationEventsProcessor, runtime: stationEventsRuntime });
  }

  if (args.config.workspaceHttp.eventsEnabled) {
    const httpEventsProcessor = createHttpEventsProcessor({
      config: {
        eventsUrl: args.config.workspaceHttp.eventsUrl,
        timeoutMs: args.config.workspaceHttp.timeoutMs,
        authToken: args.config.workspaceHttp.authToken,
      },
      logger: args.logger,
    });

    const httpEventsRuntime = createBoundedRuntime({
      processor: httpEventsProcessor,
      config: mergeRuntimeConfig(args.config.processorDefaults),
      ...common,
    });

    entries.push({ processor: httpEventsProcessor, runtime: httpEventsRuntime });
  }

  if (args.config.dbEvents.enabled) {
    const pool = new Pool({
      connectionString: args.config.dbEvents.connectionString,
    });

    let dbEventsProcessor: ReturnType<typeof createDbEventsProcessor>;
    try {
      dbEventsProcessor = createDbEventsProcessor({
        config: {
          table: args.config.dbEvents.table,
          insertTimeoutMs: args.config.dbEvents.insertTimeoutMs,
          batchWindowMs: args.config.dbEvents.batchWindowMs,
          batchMaxRows: args.config.dbEvents.batchMaxRows,
        },
        queryClient: pool,
        logger: args.logger,
      });
    } catch (error) {
      void pool.end();
      throw error;
    }

    const dbEventsRuntime = createBoundedRuntime({
      processor: dbEventsProcessor,
      config: mergeRuntimeConfig(args.config.processorDefaults, args.config.dbEvents.runtime),
      ...common,
    });

    entries.push({
      processor: dbEventsProcessor,
      runtime: withShutdownHook({
        runtime: dbEventsRuntime,
        logger: args.logger,
        shutdownHook: async () => {
          await dbEventsProcessor.flushPending();
          await pool.end();
        },
      }),
    });
  }

  if (args.config.fileEvents.enabled) {
    const fileEventsProcessor = createFileEventsProcessor({
      config: {
        filePath: args.config.fileEvents.path,
      },
      logger: args.logger,
    });

    const fileEventsRuntime = createBoundedRuntime({
      processor: fileEventsProcessor,
      config: mergeRuntimeConfig(args.config.processorDefaults),
      ...common,
    });

    entries.push({ processor: fileEventsProcessor, runtime: fileEventsRuntime });
  }

  if (args.config.uniqueTopics.enabled) {
    const uniqueTopicsProcessor = createUniqueTopicsProcessor({
      logger: args.logger,
    });

    const uniqueTopicsRuntime = createBoundedRuntime({
      processor: uniqueTopicsProcessor,
      config: mergeRuntimeConfig(args.config.processorDefaults),
      ...common,
    });

    entries.push({ processor: uniqueTopicsProcessor, runtime: uniqueTopicsRuntime });
  }

  return entries;
}
