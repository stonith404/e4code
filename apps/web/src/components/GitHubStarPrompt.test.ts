import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { MouseEvent } from "react";

import type { toastManager } from "./ui/toast";

const { add, starred, openExternal, checkStarred } = vi.hoisted(() => ({
  add: vi.fn<typeof toastManager.add>(),
  starred: { value: false, failed: false, duringCheck: () => {} },
  openExternal: vi.fn(async () => {}),
  checkStarred: vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add, close: vi.fn() } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: { checkStarred: {} } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (...args: unknown[]) => {
    checkStarred(...args);
    starred.duringCheck();
    return starred.failed ? { _tag: "Failure" } : { _tag: "Success", value: starred.value };
  },
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal } }),
}));

const environmentId = EnvironmentId.make("environment-1");

function setup({ sent = 0, writable = true, alreadyStarred = false } = {}) {
  add.mockReset();
  starred.value = alreadyStarred;
  starred.failed = false;
  starred.duringCheck = () => {};
  const store = new Map([["t3code:github-star-prompt:sent", String(sent)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!writable) throw new Error("QuotaExceededError");
        store.set(key, value);
      },
    },
  });
  return store;
}

// A fresh module import stands in for an app reload; storage survives it.
async function startSession() {
  vi.resetModules();
  const session = await import("./GitHubStarPrompt");
  return { send: () => session.recordPromptSent(environmentId) };
}

describe("recordPromptSent", () => {
  it("asks for a star on the E4 fork, not upstream", async () => {
    setup({ sent: 5 });
    checkStarred.mockClear();
    openExternal.mockClear();
    await (await startSession()).send();
    expect(add.mock.lastCall?.[0].title).toBe("Enjoying E4 Code?");
    expect(checkStarred.mock.lastCall?.[2]).toMatchObject({
      input: { repository: "stonith404/e4code" },
    });
    add.mock.lastCall?.[0].actionProps?.onClick?.({} as MouseEvent<HTMLButtonElement>);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/stonith404/e4code");
    vi.unstubAllGlobals();
  });

  it("asks after five prompts, once per session, and never again once closed", async () => {
    setup();
    let session = await startSession();
    for (let sent = 0; sent < 5; sent++) await session.send();
    expect(add).not.toHaveBeenCalled();

    await session.send();
    await session.send();
    expect(add).toHaveBeenCalledOnce();

    session = await startSession();
    await session.send();
    expect(add).toHaveBeenCalledTimes(2);

    add.mock.lastCall?.[0].onClose?.();
    session = await startSession();
    for (let sent = 0; sent < 10; sent++) await session.send();
    expect(add).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("never asks when a dismissal could not be saved", async () => {
    setup({ sent: 5, writable: false });
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never asks once the environment's GitHub account starred the repo", async () => {
    setup({ sent: 5, alreadyStarred: true });
    await (await startSession()).send();
    starred.value = false;
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("skips an unavailable server check without permanently dismissing", async () => {
    const store = setup({ sent: 5 });
    starred.failed = true;
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    expect(store.has("t3code:github-star-prompt:dismissed")).toBe(false);
    starred.failed = false;
    await (await startSession()).send();
    expect(add).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("never asks when another tab dismisses it during the star check", async () => {
    const store = setup({ sent: 5 });
    starred.duringCheck = () => store.set("t3code:github-star-prompt:dismissed", "true");
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
