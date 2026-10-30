import { assert, it } from "@effect/vitest";
import {
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { macosProfile, windowsAdmx } from "./policyTemplates.ts";

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="SOFTWARE\\Policies\\EliasSchneider\\E4Code\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

it("generates policy templates for E4 without configuring an upstream T3 installation", () => {
  const admx = windowsAdmx();
  assert.include(admx, 'namespace="EliasSchneider.Policies.E4Code"');
  assert.notInclude(admx, "T3Tools");
  const profile = macosProfile(
    { schemaVersion: 1, organization: "Example Corp" },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.strictEqual(profile._tag, "Valid");
  if (profile._tag === "Valid") {
    assert.include(profile.profile, "com.eliasschneider.e4code");
    assert.notInclude(profile.profile, "com.t3tools.t3code");
  }
});
