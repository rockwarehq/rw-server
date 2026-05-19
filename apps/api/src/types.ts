import type { FastifyBaseLogger } from "fastify";
import type { Packet } from "mqtt";

export type IServerOptions = {
  host: string;
  port: number;
  graceDelay: number;
  loggerInstance?: FastifyBaseLogger;
};

export interface BridgeConfig {
  connectionUrl: string;
  clientId?: string;
  nodeId: string;
  approvedDevices?: string[];
  clean: boolean;
  reconnectPeriod: number;
  keepalive: number;
  loggerInstance?: FastifyBaseLogger;
}

export interface DeviceMessage {
  topic: string;
  nodeId: string;
  deviceId: string;
  payload: any;
  timestamp: Date;
  packet: Packet;
}

export type MessageHandler = (message: DeviceMessage) => void | Promise<void>;

export interface TopicHandler {
  pattern: string;
  regex: RegExp;
  callback: MessageHandler;
}

export type PayloadValidator = (payload: any) => boolean;
