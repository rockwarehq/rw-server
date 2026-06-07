import "dotenv/config";

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect, StringCodec } from "nats";

import { deriveTagSubject } from "../subjects.js";
import { parseValueEnvelope, type ValueEnvelope } from "../types.js";

const codec = StringCodec();
const statePath = join(tmpdir(), "rw-livestore-last-tag-envelope.json");

const deviceId = process.env.GRAPH_DEVICE_ID ?? "press7-plc";
const tagPath = process.env.GRAPH_TAG_PATH ?? "cycleTime";
const quality = process.env.GRAPH_QUALITY ?? "good";
const samePrevious = process.argv.includes("--same");

async function main(): Promise<void> {
  const servers = (process.env.NATS_URL ?? "nats://localhost:4222")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  const nc = await connect({ servers, name: "rw-livestore-fixture-publisher" });
  const subject = deriveTagSubject(deviceId, tagPath);
  const envelope = samePrevious ? await readLastEnvelope() : buildEnvelope();

  nc.publish(subject, codec.encode(JSON.stringify(envelope)));
  await nc.drain();
  await writeLastEnvelope(envelope);

  console.log(JSON.stringify({ subject, envelope, repeatedPrevious: samePrevious }, null, 2));
}

function buildEnvelope(): ValueEnvelope {
  return {
    value: process.env.GRAPH_VALUE === undefined ? randomCycleTime() : parseValue(process.env.GRAPH_VALUE),
    quality: quality as ValueEnvelope["quality"],
    timestamp:
      process.env.GRAPH_TIMESTAMP === undefined ? Date.now() : Number.parseInt(process.env.GRAPH_TIMESTAMP, 10),
  };
}

async function readLastEnvelope(): Promise<ValueEnvelope> {
  try {
    const envelope = parseValueEnvelope(JSON.parse(await readFile(statePath, "utf8")));
    if (!envelope) throw new Error("last envelope cache is invalid");
    return envelope;
  } catch (err) {
    throw new Error(
      `No previous fixture publish found. Run fixture:publish once without --same first. (${String(err)})`,
    );
  }
}

async function writeLastEnvelope(envelope: ValueEnvelope): Promise<void> {
  await writeFile(statePath, JSON.stringify(envelope, null, 2));
}

function randomCycleTime(): number {
  return Math.round((8 + Math.random() * 12) * 10) / 10;
}

function parseValue(value: string): unknown {
  const numberValue = Number(value);
  if (value.trim() !== "" && Number.isFinite(numberValue)) return numberValue;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

main().catch((err) => {
  console.error("[livestore fixture:publish] failed", err);
  process.exit(1);
});
