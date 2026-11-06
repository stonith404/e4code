import type { Noble, Peripheral } from "@stoprocent/noble";
import * as NodeModule from "node:module";

const requireNoble = NodeModule.createRequire(import.meta.url);

const SERVICE = "4c41555a446576696365000000000001";
const RX = "4c41555a446576696365000000000002";
const TX = "4c41555a446576696365000000000003";
const REQ = "4c41555a446576696365000000000004";

export interface ClawdmeterLink {
  readonly write: (json: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ClawdmeterLinkEvents {
  /** The device has no data and asks for everything again. */
  readonly onRefresh: () => void;
  /** A tap or the device's own timeout ended the alert. */
  readonly onDismiss: () => void;
  readonly onDisconnect: () => void;
}

// The 128-bit service UUID is only in the scan response; macOS scans actively, so filtering by it works.
const discover = async (noble: Noble, signal: AbortSignal): Promise<Peripheral> => {
  await noble.startScanningAsync([SERVICE], false);
  try {
    return await new Promise((resolve, reject) => {
      const stop = () => {
        noble.removeListener("discover", found);
        reject(signal.reason);
      };
      const found = (peripheral: Peripheral) => {
        signal.removeEventListener("abort", stop);
        noble.removeListener("discover", found);
        resolve(peripheral);
      };
      noble.on("discover", found);
      signal.addEventListener("abort", stop, { once: true });
    });
  } finally {
    await noble.stopScanningAsync();
  }
};

/** Find the Clawdmeter, connect, and follow its notifications. Aborting stops the scan. */
export const connectClawdmeter = async (
  events: ClawdmeterLinkEvents,
  signal: AbortSignal,
): Promise<ClawdmeterLink> => {
  // The standalone executable needs createRequire to load file-backed Bluetooth bindings on demand
  const noble = requireNoble("@stoprocent/noble") as Noble;
  await noble.waitForPoweredOnAsync(10_000);
  const peripheral = await discover(noble, signal);
  // On macOS, disconnecting a peripheral that is already gone never settles
  const disconnect = async () => {
    if (peripheral.state !== "disconnected") await peripheral.disconnectAsync();
  };
  await peripheral.connectAsync();
  try {
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE],
      [RX, TX, REQ],
    );
    const characteristic = (uuid: string) => characteristics.find((c) => c.uuid === uuid);
    const rx = characteristic(RX);
    if (rx === undefined) throw new Error("The Clawdmeter has no RX characteristic");
    const tx = characteristic(TX);
    const req = characteristic(REQ);
    // Listen before subscribing: the device asks for data while the subscription is written.
    tx?.on("data", (data) => {
      if (data.toString().replace(/\s/g, "").includes('"dismiss":true')) events.onDismiss();
    });
    req?.on("data", () => events.onRefresh());
    await tx?.subscribeAsync();
    await req?.subscribeAsync();
    peripheral.once("disconnect", () => events.onDisconnect());
    return {
      // With response: CoreBluetooth then splits payloads longer than the MTU into a long write.
      write: (json) => rx.writeAsync(Buffer.from(json), false),
      close: disconnect,
    };
  } catch (cause) {
    await disconnect().catch(() => undefined);
    throw cause;
  }
};
