import { type McpServerConfig, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftForEnvironment,
  draftFromServer,
  serverEnabledIn,
  serverFromDraft,
  withProjectEnabled,
} from "./mcpServersSettings.logic";

const MARKER = "••••••";
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");

const saved: McpServerConfig = {
  name: "linear",
  enabled: true,
  providerInstanceIds: [CLAUDE],
  projectEnabled: { [PROJECT]: false },
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: { "X-Api-Key": MARKER },
  oauth: true,
  oauthClientId: "client",
  oauthClientSecret: MARKER,
  oauthScopes: "",
  oauthSession: MARKER,
};

describe("serverFromDraft", () => {
  it.each(["t3-code", "t3-code-direct"])("rejects the built-in %s server name", (name) => {
    const draft = { ...draftFromServer(saved, []), name };
    expect(serverFromDraft(draft, null, new Set())).toMatchObject({
      problem: { field: "name" },
    });
  });

  it("keeps saved secrets, project overrides and the sign-in until how the server signs in changes", () => {
    const draft = draftFromServer(saved, []);
    expect(serverFromDraft({ ...draft, enabled: false }, saved, new Set(["linear"]))).toEqual({
      server: { ...saved, enabled: false },
    });

    for (const change of [
      { url: "https://mcp.example.com/v2/mcp" },
      { clientId: "other-client" },
      { clientSecret: { value: "new-secret", saved: false } },
      { clientId: "" },
      { oauth: false },
    ]) {
      const result = serverFromDraft({ ...draft, ...change }, saved, new Set(["linear"]));
      expect("server" in result && result.server, JSON.stringify(change)).toMatchObject({
        oauthSession: "",
      });
    }
  });
});

describe("draftForEnvironment", () => {
  it("drops saved secrets the environment never saved and keeps typed ones", () => {
    const draft = {
      ...draftFromServer(saved, []),
      headers: [
        { id: "saved", key: "X-Api-Key", value: MARKER, saved: true },
        { id: "typed", key: "X-Team", value: "core", saved: false },
      ],
    };
    expect(draftForEnvironment(draft, null)).toMatchObject({
      headers: [{ key: "X-Team", value: "core" }],
      clientSecret: { value: "", saved: false },
    });
    expect(draftForEnvironment(draft, saved)).toEqual(draft);
  });
});

describe("withProjectEnabled", () => {
  it("overrides the environment in a project until reset", () => {
    const overridden = withProjectEnabled(saved, [OTHER_PROJECT], false);
    expect(serverEnabledIn(overridden, [])).toBe(true);
    expect(serverEnabledIn(overridden, [OTHER_PROJECT])).toBe(false);
    expect(serverEnabledIn(overridden, [PROJECT, OTHER_PROJECT])).toBe(false);
    const reset = withProjectEnabled(overridden, [PROJECT, OTHER_PROJECT], null);
    expect(reset.projectEnabled).toEqual({});
    expect(serverEnabledIn(reset, [PROJECT])).toBe(true);
  });
});
