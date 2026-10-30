import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ReviewGuideSidebar, type ReviewGuideState } from "./ReviewGuide";

const verboseFailure = Array.from({ length: 200 }, (_, line) => `provider diagnostic ${line}`).join(
  "\n",
);

it("keeps a failed local guide's Try again reachable with long diagnostics", async () => {
  const write = vi.fn(async () => {});
  const state: ReviewGuideState = {
    guide: null,
    failure: verboseFailure,
    loading: false,
    error: null,
    running: false,
    canWrite: true,
    write,
  };
  const panel = document.createElement("div");
  panel.style.cssText = "width: 280px; height: 360px; overflow: auto";
  document.body.append(panel);
  using _panel = { [Symbol.dispose]: () => panel.remove() };
  await using screen = await render(
    <ReviewGuideSidebar
      state={state}
      diffHash="current"
      cwd="/workspace"
      environmentId={EnvironmentId.make("environment")}
      groups={[]}
      uncoveredPaths={[]}
      renderFile={() => null}
    />,
    { container: panel },
  );
  const retry = screen.getByRole("button", { name: "Try again" });
  const panelBox = panel.getBoundingClientRect();
  const retryBox = retry.element().getBoundingClientRect();
  expect(retryBox.top).toBeGreaterThanOrEqual(panelBox.top);
  expect(retryBox.bottom).toBeLessThanOrEqual(panelBox.bottom);
  await expect.element(retry).toBeVisible();
  await userEvent.click(retry);
  expect(write).toHaveBeenCalledOnce();
  await expect
    .element(screen.getByText("Check the review guide model in Settings → Source control."))
    .toBeVisible();
  const details = panel.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain(verboseFailure);
});
