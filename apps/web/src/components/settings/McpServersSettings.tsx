import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type McpServerConfig,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { CopyIcon, EllipsisIcon, PlugIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readPreparedConnection, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  draftForEnvironment,
  draftFromServer,
  type McpServerDraft,
  type McpServerDraftProblem,
  mcpServerRedirectUri,
  type SecretEntryDraft,
  serverEnabledIn,
  serverFromDraft,
  withProjectEnabled,
} from "./mcpServersSettings.logic";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsPageContainer, SettingsSection } from "./settingsLayout";

const SUPPORTED_DRIVERS = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

interface ProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

export function McpServersSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const members = connectedEnvironments.filter(
    (candidate) => candidate.serverConfig?.mcpServerSettings === true,
  );
  if (members.length > 0) {
    return (
      <SettingsPageContainer>
        <McpServers
          key={environmentIdsKey(members.map((member) => member.environmentId))}
          members={members}
          projects={scope.kind === "project" || scope.kind === "checkout" ? scope.members : []}
        />
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("mcp-servers")}>
        <McpServersEmpty
          title="MCP servers unavailable"
          description={
            environment !== null
              ? `Update ${environment.label} to manage its MCP servers.`
              : "Connect an environment to manage the MCP servers its Claude and Codex sessions use."
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function McpServersEmpty(props: { readonly title: string; readonly description: string }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <PlugIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

interface Holding {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The selected project's IDs in this environment; empty outside a project scope. */
  readonly projectIds: ReadonlyArray<ProjectId>;
}

interface HeldServer extends Holding {
  readonly server: McpServerConfig;
}

const providersAtom = environmentAtomList("web-mcp-server-providers", (environmentId) =>
  serverEnvironment.providersValueAtom(environmentId),
);

/** One row per server name; with several environments selected, every change reaches each of them. */
function McpServers({
  members,
  projects,
}: {
  readonly members: ReadonlyArray<EnvironmentPresentation>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}) {
  // A stdio server is a command the host runs, so it takes the provider settings grant.
  const writable = useEnvironmentsWithScope(members, AuthProvidersManageScope);
  const readOnly = members.some((member) => !writable.has(member.environmentId));
  const projectScoped = projects.length > 0;
  const multiple = members.length > 1;
  const holdings = members.map((member) => ({
    environmentId: member.environmentId,
    label: settingsScopeEnvironmentLabel(member, members),
    projectIds: projects
      .filter((project) => project.environmentId === member.environmentId)
      .map((project) => project.id),
    servers: member.serverConfig?.settings.mcpServers ?? [],
  }));
  const providerLists = useAtomValue(
    providersAtom(environmentIdsKey(members.map((member) => member.environmentId))),
  );
  const choices: ReadonlyArray<ProviderChoice> = [
    ...new Map(
      providerLists
        .flatMap((providers) => providers ?? [])
        .filter((provider) => SUPPORTED_DRIVERS.has(provider.driver))
        .map((provider) => [
          provider.instanceId,
          { instanceId: provider.instanceId, label: resolveProviderInstanceDisplayName(provider) },
        ]),
    ).values(),
  ];
  const labels = new Map(choices.map((choice) => [choice.instanceId, choice.label]));
  const rows = new Map<string, HeldServer[]>();
  for (const holding of holdings) {
    for (const server of holding.servers) {
      rows.set(server.name, [...(rows.get(server.name) ?? []), { ...holding, server }]);
    }
  }
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<null | { readonly server: McpServerConfig | null }>(null);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);
  const [busy, setBusy] = useState(false);

  /** `next` returns an environment's new server list, or null to leave it alone. */
  const save = async (
    next: (
      servers: ReadonlyArray<McpServerConfig>,
      holding: Holding,
    ) => ReadonlyArray<McpServerConfig> | null,
  ) => {
    const writes = holdings.flatMap((holding) => {
      const servers = next(holding.servers, holding);
      return servers === null ? [] : [{ holding, servers }];
    });
    setBusy(true);
    const results = await Promise.all(
      writes.map(({ holding, servers }) =>
        updateSettings({
          environmentId: holding.environmentId,
          input: { patch: { mcpServers: servers } },
        }),
      ),
    );
    setBusy(false);
    const failed = writes.flatMap(({ holding }, index) => {
      const result = results[index];
      return result && result._tag !== "Success"
        ? [`${holding.label}: ${failureMessage(result.cause)}`]
        : [];
    });
    if (failed.length === 0) return true;
    toastManager.add({
      type: "error",
      title: "MCP server not saved",
      description: failed.join("\n"),
    });
    return false;
  };
  const change = (
    name: string,
    apply: (server: McpServerConfig, holding: Holding) => McpServerConfig | null,
  ) =>
    save((servers, holding) =>
      servers.some((server) => server.name === name)
        ? servers.flatMap((server) => {
            const next = server.name === name ? apply(server, holding) : server;
            return next === null ? [] : [next];
          })
        : null,
    );
  const upsert = (draft: McpServerDraft, missingOnly = false) =>
    save((servers, holding) => {
      const previous = servers.find((server) => server.name === draft.name.trim()) ?? null;
      if (previous !== null && missingOnly) return null;
      const plan = serverFromDraft(
        draftForEnvironment(draft, previous),
        previous,
        new Set(servers.map((server) => server.name)),
      );
      if (!("server" in plan)) return null;
      // A server added from a project's settings is on only in that project.
      const added =
        previous === null && !missingOnly && holding.projectIds.length > 0
          ? withProjectEnabled({ ...plan.server, enabled: false }, holding.projectIds, true)
          : plan.server;
      return previous === null
        ? [...servers, added]
        : servers.map((server) => (server === previous ? plan.server : server));
    });

  return (
    <>
      <SettingsSection
        {...searchableSetting("mcp-servers")}
        headerAction={
          readOnly ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => setEditing({ server: null })}
            >
              <PlusIcon className="size-3" />
              <span>Add server</span>
            </Button>
          )
        }
      >
        {projectScoped ? (
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Servers are shared across the environment. The switch turns one on or off in this
            project.
          </p>
        ) : null}
        {rows.size === 0 ? (
          <McpServersEmpty
            title="No MCP servers"
            description={
              readOnly
                ? "Claude and Codex sessions here get no extra MCP servers."
                : "Click “Add server” to give Claude and Codex the tools of another MCP server."
            }
          />
        ) : (
          [...rows.entries()].map(([name, holders]) => (
            <McpServerRow
              key={name}
              holders={holders}
              missing={holdings
                .filter(
                  (holding) =>
                    !holders.some((holder) => holder.environmentId === holding.environmentId),
                )
                .map((holding) => holding.label)}
              multiple={multiple}
              providerLabels={(holders[0]?.server.providerInstanceIds ?? []).map(
                (id) => labels.get(id) ?? id,
              )}
              readOnly={readOnly}
              busy={busy}
              onToggle={(enabled) =>
                void change(name, (server, holding) =>
                  holding.projectIds.length === 0
                    ? { ...server, enabled }
                    : withProjectEnabled(server, holding.projectIds, enabled),
                )
              }
              onResetProject={() =>
                void change(name, (server, holding) =>
                  withProjectEnabled(server, holding.projectIds, null),
                )
              }
              onSignOut={() =>
                void change(name, (server) =>
                  server.transport === "http" ? { ...server, oauthSession: "" } : server,
                )
              }
              onAddEverywhere={(server) => void upsert(draftFromServer(server, []), true)}
              onEdit={(server) => setEditing({ server })}
              onRemove={(server) => setRemoving(server)}
            />
          ))
        )}
      </SettingsSection>
      {editing !== null && !readOnly ? (
        <McpServerDialog
          environments={holdings}
          server={editing.server}
          choices={choices}
          takenNames={new Set(rows.keys())}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            if (await upsert(draft)) setEditing(null);
          }}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New Claude and Codex sessions stop getting its tools, and its saved secrets and
              sign-in are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const name = removing?.name;
                setRemoving(null);
                if (name !== undefined) void change(name, () => null);
              }}
            >
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const signedIn = (server: McpServerConfig) =>
  server.transport === "http" && server.oauthSession !== "";

function McpServerRow(props: {
  readonly holders: ReadonlyArray<HeldServer>;
  readonly missing: ReadonlyArray<string>;
  readonly multiple: boolean;
  readonly providerLabels: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onResetProject: () => void;
  readonly onSignOut: () => void;
  readonly onAddEverywhere: (server: McpServerConfig) => void;
  readonly onEdit: (server: McpServerConfig) => void;
  readonly onRemove: (server: McpServerConfig) => void;
}) {
  const [first] = props.holders;
  if (first === undefined) return null;
  const { server } = first;
  const unsigned = props.holders.filter(
    (holder) =>
      holder.server.transport === "http" && holder.server.oauth && !signedIn(holder.server),
  );
  const enabled = props.holders.every((holder) =>
    serverEnabledIn(holder.server, holder.projectIds),
  );
  const projectOverridden = props.holders.some((holder) =>
    holder.projectIds.some((id) => Object.hasOwn(holder.server.projectEnabled, id)),
  );
  const target = server.transport === "stdio" ? server.command : server.url;
  const providers =
    props.providerLabels.length === 0 ? "No providers" : props.providerLabels.join(", ");
  return (
    <div className="flex items-center gap-3 border-t border-border/60 px-3 py-3 first:border-t-0 sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-medium">{server.name}</p>
          {unsigned.length > 0 ? (
            <Badge variant="secondary" size="sm">
              {props.multiple
                ? `Not signed in on ${unsigned.map((holder) => holder.label).join(", ")}`
                : "Not signed in"}
            </Badge>
          ) : null}
          {props.missing.length > 0 ? (
            <Badge variant="secondary" size="sm">
              Not on {props.missing.join(", ")}
            </Badge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {target} · {providers}
        </p>
      </div>
      {props.readOnly ? null : (
        <div className="flex shrink-0 items-center gap-3">
          {unsigned.length > 0 ? (
            <SignInButton
              targets={unsigned}
              multiple={props.multiple}
              name={server.name}
              disabled={props.busy}
            />
          ) : null}
          <div className="flex items-center gap-1">
            {projectOverridden ? (
              <SettingResetButton
                label={`${server.name} in this project`}
                tooltip="Use the environment setting"
                disabled={props.busy}
                onClick={props.onResetProject}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    size="sm"
                    aria-label={`${enabled ? "Switch off" : "Switch on"} ${server.name}`}
                    checked={enabled}
                    disabled={props.busy}
                    onCheckedChange={(checked) => props.onToggle(checked)}
                  />
                }
              />
              <TooltipPopup side="top">{enabled ? "Switch off" : "Switch on"}</TooltipPopup>
            </Tooltip>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={props.busy}
                    aria-label={`More actions for ${server.name}`}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => props.onEdit(server)}>Edit…</MenuItem>
                {props.missing.length > 0 ? (
                  <MenuItem onClick={() => props.onAddEverywhere(server)}>
                    Add to {props.missing.join(", ")}
                  </MenuItem>
                ) : null}
                {props.holders.some((holder) => signedIn(holder.server)) ? (
                  <MenuItem onClick={props.onSignOut}>Sign out</MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => props.onRemove(server)}>
                  Remove…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </div>
      )}
    </div>
  );
}

/** Each environment keeps its own sign-in, so with several selected the button asks which one. */
function SignInButton(props: {
  readonly targets: ReadonlyArray<Holding>;
  readonly multiple: boolean;
  readonly name: string;
  readonly disabled: boolean;
}) {
  const start = useAtomCommand(serverEnvironment.startMcpServerOAuth, { reportFailure: false });
  const [state, setState] = useState<"idle" | "starting" | "opened">("idle");
  const signIn = async (target: Holding) => {
    const connection = readPreparedConnection(target.environmentId);
    if (connection === null) {
      toastManager.add({ type: "error", title: `Reconnect to ${target.label} and try again.` });
      return;
    }
    setState("starting");
    const result = await start({
      environmentId: target.environmentId,
      input: { name: props.name, redirectUri: mcpServerRedirectUri(connection.httpBaseUrl) },
    });
    if (result._tag !== "Success") {
      setState("idle");
      toastManager.add({
        type: "error",
        title: `Could not sign in to ${props.name}`,
        description: failureMessage(result.cause),
      });
      return;
    }
    // The environment's callback page finishes the sign-in, and settings then show it.
    setState("opened");
    await readLocalApi()?.shell.openExternal(result.value.authorizationUrl);
  };
  const [only] = props.targets;
  if (!props.multiple && only !== undefined) {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || state === "starting"}
        onClick={() => void signIn(only)}
      >
        {state === "starting" ? <Spinner size="xs" /> : null}
        {state === "opened" ? "Open sign-in again" : "Sign in"}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" disabled={props.disabled || state === "starting"} />
        }
      >
        {state === "starting" ? <Spinner size="xs" /> : null}
        Sign in
      </MenuTrigger>
      <MenuPopup align="end">
        {props.targets.map((target) => (
          <MenuItem key={target.environmentId} onClick={() => void signIn(target)}>
            {target.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function McpServerDialog(props: {
  readonly environments: ReadonlyArray<Holding>;
  readonly server: McpServerConfig | null;
  readonly choices: ReadonlyArray<ProviderChoice>;
  readonly takenNames: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: McpServerDraft) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() =>
    draftFromServer(
      props.server,
      props.choices.map((choice) => choice.instanceId),
    ),
  );
  const [submitted, setSubmitted] = useState(false);
  const update = (patch: Partial<McpServerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const plan = serverFromDraft(draft, props.server, props.takenNames);
  const problem = "problem" in plan ? plan.problem : null;
  const errorFor = (field: McpServerDraftProblem["field"]) =>
    submitted && problem?.field === field ? problem.message : undefined;
  const redirectUris = props.environments.flatMap((environment) => {
    const connection = readPreparedConnection(environment.environmentId);
    return connection === null
      ? []
      : [{ ...environment, uri: mcpServerRedirectUri(connection.httpBaseUrl) }];
  });
  const usesClientId = draft.clientId.trim() !== "";
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Redirect URI copied" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy the redirect URI",
        description: error.message,
      }),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!props.busy}>
        <DialogHeader>
          <DialogTitle>
            {props.server === null ? "Add MCP server" : `Edit ${props.server.name}`}
          </DialogTitle>
          <DialogDescription>
            Sessions of the selected providers get this server's tools when they start.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={`${id}-form`}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if ("server" in plan && !props.busy) props.onSave(draft);
            }}
          >
            {props.server === null ? (
              <Field label="Name" htmlFor={`${id}-name`} error={errorFor("name")}>
                <Input
                  id={`${id}-name`}
                  autoFocus
                  placeholder="linear"
                  maxLength={64}
                  spellCheck={false}
                  value={draft.name}
                  disabled={props.busy}
                  aria-invalid={errorFor("name") !== undefined}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
            ) : null}
            <Field label="Add to">
              {props.choices.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No Claude or Codex provider is set up.
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {props.choices.map((choice) => (
                    <label key={choice.instanceId} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.providerInstanceIds.includes(choice.instanceId)}
                        disabled={props.busy}
                        onCheckedChange={(checked) =>
                          update({
                            providerInstanceIds: checked
                              ? [...draft.providerInstanceIds, choice.instanceId]
                              : draft.providerInstanceIds.filter((id) => id !== choice.instanceId),
                          })
                        }
                      />
                      {choice.label}
                    </label>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Transport" htmlFor={`${id}-transport`}>
              <Select
                value={draft.transport}
                disabled={props.busy}
                onValueChange={(value) => {
                  if (value === "stdio" || value === "http") update({ transport: value });
                }}
              >
                <SelectTrigger id={`${id}-transport`}>
                  <SelectValue>
                    {draft.transport === "http" ? "Streamable HTTP" : "Command (stdio)"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="http">Streamable HTTP</SelectItem>
                  <SelectItem value="stdio">Command (stdio)</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.transport === "stdio" ? (
              <>
                <Field label="Command" htmlFor={`${id}-command`} error={errorFor("command")}>
                  <Input
                    id={`${id}-command`}
                    placeholder="npx"
                    spellCheck={false}
                    value={draft.command}
                    disabled={props.busy}
                    aria-invalid={errorFor("command") !== undefined}
                    onChange={(event) => update({ command: event.target.value })}
                  />
                </Field>
                <Field label="Arguments" htmlFor={`${id}-args`} hint="One argument per line.">
                  <Textarea
                    id={`${id}-args`}
                    rows={3}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                    spellCheck={false}
                    value={draft.args}
                    disabled={props.busy}
                    onChange={(event) => update({ args: event.target.value })}
                  />
                </Field>
                <SecretEntries
                  label="Variables"
                  noun="variable"
                  keyPlaceholder="VARIABLE_NAME"
                  entries={draft.env}
                  busy={props.busy}
                  onChange={(env) => update({ env })}
                />
              </>
            ) : (
              <>
                <Field label="URL" htmlFor={`${id}-url`} error={errorFor("url")}>
                  <Input
                    id={`${id}-url`}
                    type="url"
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                    value={draft.url}
                    disabled={props.busy}
                    aria-invalid={errorFor("url") !== undefined}
                    onChange={(event) => update({ url: event.target.value })}
                  />
                </Field>
                <SecretEntries
                  label="Headers"
                  noun="header"
                  keyPlaceholder="X-Api-Key"
                  entries={draft.headers}
                  busy={props.busy}
                  onChange={(headers) => update({ headers })}
                />
                <Field label="Authentication" htmlFor={`${id}-auth`}>
                  <Select
                    value={draft.oauth ? "oauth" : "none"}
                    disabled={props.busy}
                    onValueChange={(value) => update({ oauth: value === "oauth" })}
                  >
                    <SelectTrigger id={`${id}-auth`}>
                      <SelectValue>{draft.oauth ? "OAuth" : "None"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="oauth">OAuth</SelectItem>
                    </SelectPopup>
                  </Select>
                </Field>
                {draft.oauth ? (
                  <>
                    <Field
                      label="Client ID"
                      htmlFor={`${id}-client-id`}
                      hint={
                        usesClientId
                          ? undefined
                          : "Optional. Without one, E4 Code registers itself with the server."
                      }
                    >
                      <Input
                        id={`${id}-client-id`}
                        placeholder="For a client registered with the server"
                        spellCheck={false}
                        value={draft.clientId}
                        disabled={props.busy}
                        onChange={(event) => update({ clientId: event.target.value })}
                      />
                    </Field>
                    {usesClientId ? (
                      <Field label="Client secret" htmlFor={`${id}-client-secret`}>
                        <SecretInput
                          id={`${id}-client-secret`}
                          configured={draft.clientSecret.saved}
                          placeholder="None, for a public client"
                          value={draft.clientSecret.saved ? "" : draft.clientSecret.value}
                          disabled={props.busy}
                          onChange={(event) =>
                            update({ clientSecret: { value: event.target.value, saved: false } })
                          }
                        />
                      </Field>
                    ) : null}
                    <Field
                      label="Scopes"
                      htmlFor={`${id}-scopes`}
                      hint="Space-separated. Leave empty for the scopes the server asks for."
                    >
                      <Input
                        id={`${id}-scopes`}
                        spellCheck={false}
                        value={draft.scopes}
                        disabled={props.busy}
                        onChange={(event) => update({ scopes: event.target.value })}
                      />
                    </Field>
                    {usesClientId
                      ? redirectUris.map((redirect) => (
                          <Field
                            key={redirect.environmentId}
                            label={
                              redirectUris.length > 1
                                ? `Redirect URI on ${redirect.label}`
                                : "Redirect URI"
                            }
                            hint="Register it with the client."
                          >
                            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
                                {redirect.uri}
                              </code>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      type="button"
                                      size="icon-xs"
                                      variant="ghost-muted"
                                      className="shrink-0"
                                      aria-label="Copy redirect URI"
                                      onClick={() => copyToClipboard(redirect.uri, undefined)}
                                    />
                                  }
                                >
                                  <CopyIcon className="size-3" />
                                </TooltipTrigger>
                                <TooltipPopup side="top">Copy redirect URI</TooltipPopup>
                              </Tooltip>
                            </div>
                          </Field>
                        ))
                      : null}
                  </>
                ) : null}
              </>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={props.busy || (submitted && problem !== null)}
          >
            {props.busy ? <Spinner size="xs" /> : null}
            {props.server === null ? "Add server" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
      {props.error === undefined ? null : (
        <p role="alert" className="text-xs text-destructive">
          {props.error}
        </p>
      )}
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

/** Name and value rows whose values the environment keeps as secrets. */
function SecretEntries(props: {
  readonly label: string;
  readonly noun: string;
  readonly keyPlaceholder: string;
  readonly entries: ReadonlyArray<SecretEntryDraft>;
  readonly busy: boolean;
  readonly onChange: (entries: ReadonlyArray<SecretEntryDraft>) => void;
}) {
  const set = (index: number, entry: SecretEntryDraft) =>
    props.onChange(props.entries.map((current, at) => (at === index ? entry : current)));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{props.label}</Label>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={props.busy}
          onClick={() =>
            props.onChange([
              ...props.entries,
              { id: randomUUID(), key: "", value: "", saved: false },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add {props.noun}
        </Button>
      </div>
      {props.entries.map((entry, index) => (
        <div key={entry.id} className="flex min-w-0 items-center gap-1.5">
          <Input
            size="sm"
            font="mono"
            className="w-2/5"
            aria-label={`${props.label} name ${index + 1}`}
            placeholder={props.keyPlaceholder}
            spellCheck={false}
            value={entry.key}
            disabled={props.busy}
            // The saved value is stored under the old name, so a renamed entry needs a new one.
            onChange={(event) =>
              set(
                index,
                entry.saved
                  ? { id: entry.id, key: event.target.value, value: "", saved: false }
                  : { ...entry, key: event.target.value },
              )
            }
          />
          <SecretInput
            size="sm"
            font="mono"
            className="min-w-0 flex-1"
            aria-label={`${props.label} value ${index + 1}`}
            placeholder="value"
            configured={entry.saved}
            value={entry.saved ? "" : entry.value}
            disabled={props.busy}
            onChange={(event) => set(index, { ...entry, value: event.target.value, saved: false })}
          />
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-destructive"
            aria-label={`Remove ${props.noun} ${entry.key || index + 1}`}
            disabled={props.busy}
            onClick={() => props.onChange(props.entries.filter((_, at) => at !== index))}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      {props.entries.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Values are stored separately and never returned to the app.
        </p>
      ) : null}
    </div>
  );
}
