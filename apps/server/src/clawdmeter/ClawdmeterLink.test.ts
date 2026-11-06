import * as NodeEvents from "node:events";

import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { connectClawdmeter } from "./ClawdmeterLink.ts";

const noble = vi.hoisted(() => {
  const NodeEvents = require("node:events") as typeof import("node:events");
  return Object.assign(new NodeEvents.EventEmitter(), {
    waitForPoweredOnAsync: async () => {},
    startScanningAsync: async () => {},
    stopScanningAsync: async () => {},
  });
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: () => () => noble };
});

const characteristic = (uuid: string) =>
  Object.assign(new NodeEvents.EventEmitter(), {
    uuid,
    subscribeAsync: async () => {},
    writeAsync: async () => {},
  });

// Mirrors noble on macOS: a disconnected peripheral's handle is gone, so a cancel never reports back
const peripheral = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    state: "connected",
    connectAsync: async () => {},
    discoverSomeServicesAndCharacteristicsAsync: async () => ({
      characteristics: ["2", "3", "4"].map((n) =>
        characteristic(`4c41555a44657669636500000000000${n}`),
      ),
    }),
    disconnectAsync(this: { state: string }) {
      if (this.state === "disconnected") return Promise.reject(new Error("never settles"));
      this.state = "disconnected";
      return Promise.resolve();
    },
  });

it("closes a link whose board already disconnected", async () => {
  const board = peripheral();
  noble.once("newListener", () => queueMicrotask(() => noble.emit("discover", board)));
  const onDisconnect = vi.fn();
  const link = await connectClawdmeter(
    { onRefresh: () => {}, onDismiss: () => {}, onDisconnect },
    new AbortController().signal,
  );

  board.state = "disconnected";
  board.emit("disconnect");

  expect(onDisconnect).toHaveBeenCalled();
  await expect(link.close()).resolves.toBeUndefined();
});
