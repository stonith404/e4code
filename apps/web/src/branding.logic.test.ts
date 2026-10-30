import { assert, it } from "vite-plus/test";
import {
  formatAppDisplayName,
  resolveWebAppStageLabel,
  resolveWindowTitle,
} from "./branding.logic";

it("keeps E4 web channel labels and thread titles without restoring the Beta label", () => {
  const stageLabel = resolveWebAppStageLabel({ hostedAppChannel: null, development: false });
  assert.equal(stageLabel, "Latest");
  const appDisplayName = formatAppDisplayName({ baseName: "E4 Code", stageLabel });
  assert.equal(
    resolveWindowTitle({
      appDisplayName,
      projectTitle: "Project",
      threadTitle: "Thread",
      desktop: false,
    }),
    "Project / Thread - E4 Code",
  );
  assert.equal(
    resolveWebAppStageLabel({ hostedAppChannel: "nightly", development: false }),
    "Nightly",
  );
  assert.equal(resolveWebAppStageLabel({ hostedAppChannel: null, development: true }), "Dev");
});
