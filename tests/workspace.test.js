import assert from "node:assert/strict";
import test from "node:test";
import { createManager } from "../src/model.js";

const gameId = "lethal-company";
const latestVersionsKey = "modrelay:latest-versions:v1";

function memoryStorage() {
  const entries = new Map();
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

function thunderstorePackage(name, version, dependencies = [], community = gameId) {
  const namespace = "Test-team";
  return {
    id: `${community}/${namespace}/${name}`,
    gameId: community,
    namespace,
    name,
    version,
    dependencies,
    description: `${name} package`,
    icon: "https://gcdn.thunderstore.io/test.png",
  };
}

function dependencyWorkspace() {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const shared = thunderstorePackage("Shared", "1.0.0");
  const runtime = thunderstorePackage("Runtime", "1.0.0", [shared]);
  const helper = thunderstorePackage("Helper", "1.0.0", [runtime]);
  const plugin = thunderstorePackage("Plugin", "1.0.0", [helper]);
  const branch = thunderstorePackage("Branch", "1.0.0", [runtime]);
  const unrelated = thunderstorePackage("Unrelated", "1.0.0", [shared]);
  const packages = [shared, runtime, helper, plugin, branch, unrelated];
  workspace.recordDownloads(workspace.profile.id, gameId, packages, packages.map(mod => mod.id));
  return { storage, workspace, shared, runtime, helper, plugin, branch, unrelated, packages };
}

test("sample profiles track transitive dependencies and prevent removing a required package", () => {
  const workspace = createManager(memoryStorage());
  workspace.createProfile("Sandbox");

  assert.deepEqual(workspace.install("lethalexpansion"), ["bepinexpack", "lethallib", "lethalexpansion"]);
  assert.throws(() => workspace.remove("bepinexpack"), /requires BepInExPack/);
  assert.throws(() => workspace.setEnabled("bepinexpack", false), /requires BepInExPack/);
  assert.deepEqual(workspace.setEnabled("lethalexpansion", false), ["lethalexpansion"]);
  assert.deepEqual(workspace.setEnabled("lethallib", false), ["lethallib"]);
  assert.deepEqual(workspace.setEnabled("bepinexpack", false), ["bepinexpack"]);
  assert.throws(() => workspace.setEnabled("lethalexpansion", true), /Enable BepInExPack before enabling LethalExpansion/);
  assert.deepEqual(workspace.setEnabled("bepinexpack", true), ["bepinexpack"]);
  assert.deepEqual(workspace.setEnabled("lethallib", true), ["lethallib"]);
  assert.deepEqual(workspace.setEnabled("lethalexpansion", true), ["lethalexpansion"]);
  assert.deepEqual(workspace.install("lethalexpansion"), []);
});

test("live mod toggles affect only the selected mod and preserve shared dependencies", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const runtime = thunderstorePackage("Runtime", "1.0.0");
  const plugin = thunderstorePackage("Plugin", "1.0.0", [runtime]);
  const otherPlugin = thunderstorePackage("OtherPlugin", "1.0.0", [runtime]);
  const unrelated = thunderstorePackage("Unrelated", "1.0.0");
  const packages = [runtime, plugin, otherPlugin, unrelated];
  workspace.recordDownloads(workspace.profile.id, gameId, packages, packages.map(mod => mod.id));
  const enabled = () => Object.fromEntries(workspace.installed.map(entry => [entry.mod.name, entry.enabled]));

  assert.deepEqual(workspace.setEnabled(plugin.id, false), [plugin.id]);
  assert.deepEqual(enabled(), { Runtime: true, Plugin: false, OtherPlugin: true, Unrelated: true });
  assert.deepEqual(workspace.setEnabled(plugin.id, true), [plugin.id]);
  assert.deepEqual(enabled(), { Runtime: true, Plugin: true, OtherPlugin: true, Unrelated: true });
  const beforeRejectedDisable = structuredClone(workspace.state);
  assert.throws(() => workspace.setEnabled(runtime.id, false), /Plugin requires Runtime. Disable Plugin first/);
  assert.deepEqual(workspace.state, beforeRejectedDisable);

  workspace.setEnabled(plugin.id, false);
  workspace.setEnabled(otherPlugin.id, false);
  assert.deepEqual(workspace.setEnabled(runtime.id, false), [runtime.id]);
  assert.deepEqual(enabled(), { Runtime: false, Plugin: false, OtherPlugin: false, Unrelated: true });
  const beforeRejectedEnable = structuredClone(workspace.state);
  assert.throws(() => workspace.setEnabled(plugin.id, true), /Enable Runtime before enabling Plugin/);
  assert.deepEqual(workspace.state, beforeRejectedEnable);
  assert.deepEqual(createManager(storage, { live: true }).profile.mods, workspace.profile.mods);

  assert.deepEqual(workspace.setEnabled(runtime.id, true), [runtime.id]);
  assert.deepEqual(workspace.setEnabled(plugin.id, true), [plugin.id]);
  assert.deepEqual(enabled(), { Runtime: true, Plugin: true, OtherPlugin: false, Unrelated: true });
  assert.deepEqual(workspace.setEnabled(plugin.id, true), []);
});

test("dependency choices expose transitive requirements and enable the requested closure atomically", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const runtime = thunderstorePackage("Runtime", "1.0.0");
  const helper = thunderstorePackage("Helper", "1.0.0", [runtime]);
  const plugin = thunderstorePackage("Plugin", "1.0.0", [helper]);
  const unrelated = thunderstorePackage("Unrelated", "1.0.0");
  const packages = [runtime, helper, plugin, unrelated];
  workspace.recordDownloads(workspace.profile.id, gameId, packages, packages.map(mod => mod.id));
  workspace.setEnabled(plugin.id, false);
  workspace.setEnabled(helper.id, false);
  workspace.setEnabled(runtime.id, false);
  workspace.setEnabled(unrelated.id, false);

  const requirements = workspace.getToggleRequirements(plugin.id, true);
  assert.equal(requirements.mod.id, plugin.id);
  assert.deepEqual(requirements.dependencies.map(mod => mod.id), [runtime.id, helper.id]);
  assert.deepEqual(requirements.dependents, []);
  assert.deepEqual(workspace.getToggleRequirements(runtime.id, false).dependents, []);
  assert.deepEqual(workspace.setEnabled(plugin.id, true, { includeDependencies: true }), [runtime.id, helper.id, plugin.id]);
  assert.deepEqual(workspace.installed.map(entry => [entry.mod.name, entry.enabled]), [
    ["Runtime", true], ["Helper", true], ["Plugin", true], ["Unrelated", false],
  ]);
  assert.deepEqual(workspace.getToggleRequirements(runtime.id, false).dependents.map(mod => mod.id), [helper.id, plugin.id]);

  workspace.setEnabled(runtime.id, false, { force: true });
  const before = structuredClone(workspace.state);
  storage.setItem = () => { throw new Error("full"); };
  assert.throws(() => workspace.setEnabled(plugin.id, true, { includeDependencies: true }), /could not save/);
  assert.deepEqual(workspace.state, before);
});

test("forced toggles persist through reload and profile sharing without changing other mods", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const runtime = thunderstorePackage("Runtime", "1.0.0");
  const plugin = thunderstorePackage("Plugin", "1.0.0", [runtime]);
  const unrelated = thunderstorePackage("Unrelated", "1.0.0");
  const packages = [runtime, plugin, unrelated];
  workspace.recordDownloads(workspace.profile.id, gameId, packages, packages.map(mod => mod.id));
  assert.deepEqual(workspace.setEnabled(runtime.id, false, { force: true }), [runtime.id]);
  assert.equal(workspace.installed.find(entry => entry.id === plugin.id).enabled, true);
  assert.deepEqual(createManager(storage, { live: true }).profile.mods, workspace.profile.mods);

  workspace.setEnabled(plugin.id, false);
  assert.deepEqual(workspace.setEnabled(plugin.id, true, { force: true }), [plugin.id]);
  assert.equal(workspace.installed.find(entry => entry.id === runtime.id).enabled, false);
  const target = createManager(memoryStorage(), { live: true });
  const imported = target.importProfile(workspace.exportProfile().code, packages);
  assert.equal(imported.mods.find(entry => entry.id === runtime.id).enabled, false);
  assert.equal(imported.mods.find(entry => entry.id === plugin.id).enabled, true);
  assert.equal(imported.mods.find(entry => entry.id === unrelated.id).enabled, true);

  const invalid = JSON.parse(workspace.exportProfile().json);
  invalid.mods = invalid.mods.filter(entry => entry.id !== runtime.id);
  assert.throws(() => target.readImport(JSON.stringify(invalid)), /Plugin requires Runtime/);
});

test("disabling affected mods follows transitive branches and preserves shared prerequisites", () => {
  const { storage, workspace, shared, runtime, helper, plugin, branch, unrelated, packages } = dependencyWorkspace();
  workspace.setEnabled(plugin.id, false);
  assert.deepEqual(workspace.setEnabled(runtime.id, false, { includeDependents: true }), [runtime.id, helper.id, branch.id]);
  assert.deepEqual(workspace.installed.map(entry => [entry.id, entry.enabled]), [
    [shared.id, true], [runtime.id, false], [helper.id, false], [plugin.id, false], [branch.id, false], [unrelated.id, true],
  ]);
  assert.deepEqual(createManager(storage, { live: true }).profile.mods, workspace.profile.mods);
  const imported = createManager(memoryStorage(), { live: true }).importProfile(workspace.exportProfile().code, packages);
  assert.deepEqual(imported.mods, workspace.profile.mods);
});

test("disabling affected mods also works when Disable anyway already disabled the selected mod", () => {
  const { workspace, runtime, helper, plugin, branch, unrelated } = dependencyWorkspace();
  assert.deepEqual(workspace.setEnabled(runtime.id, false, { force: true }), [runtime.id]);
  assert.equal(workspace.installed.find(entry => entry.id === helper.id).enabled, true);
  assert.equal(workspace.installed.find(entry => entry.id === plugin.id).enabled, true);
  assert.deepEqual(workspace.setEnabled(runtime.id, false, { includeDependents: true }), [helper.id, plugin.id, branch.id]);
  assert.equal(workspace.installed.find(entry => entry.id === unrelated.id).enabled, true);
  assert.deepEqual(workspace.setEnabled(runtime.id, false, { includeDependents: true }), []);
});

test("removing affected mods includes disabled dependents and preserves unrelated shared dependencies", () => {
  const { storage, workspace, shared, runtime, helper, plugin, branch, unrelated } = dependencyWorkspace();
  workspace.setEnabled(plugin.id, false);
  const before = structuredClone(workspace.state);
  const requirements = workspace.getRemovalRequirements(runtime.id);
  assert.equal(requirements.mod.id, runtime.id);
  assert.deepEqual(requirements.dependents.map(mod => mod.id), [helper.id, plugin.id, branch.id]);
  assert.deepEqual(workspace.state, before);
  assert.throws(() => workspace.remove(runtime.id), /requires Runtime/);
  assert.deepEqual(workspace.state, before);

  assert.deepEqual(workspace.remove(runtime.id, { includeDependents: true }), [runtime.id, helper.id, plugin.id, branch.id]);
  assert.deepEqual(workspace.installed.map(entry => entry.id), [shared.id, unrelated.id]);
  assert.deepEqual(createManager(storage, { live: true }).profile.mods, workspace.profile.mods);
  const imported = createManager(memoryStorage(), { live: true }).importProfile(workspace.exportProfile().code, [shared, unrelated]);
  assert.deepEqual(imported.mods, workspace.profile.mods);
});

test("removing affected mods removes their saved configuration entries", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage);
  workspace.createProfile("Removal configs");
  workspace.install("morecompany");
  workspace.install("skinwalkers");
  workspace.saveConfig("morecompany", "Max Players = 12");
  workspace.saveConfig("skinwalkers", "Voice Chance = 0.5");
  assert.deepEqual(workspace.remove("bepinexpack", { includeDependents: true }), ["bepinexpack", "morecompany", "skinwalkers"]);
  assert.deepEqual(workspace.profile.mods, []);
  assert.deepEqual(workspace.profile.configs, {});
  assert.deepEqual(createManager(storage).profile, workspace.profile);
  assert.deepEqual(workspace.readImport(workspace.exportProfile().code).configs, {});
});

test("affected-mod disable and removal both roll back when saving fails", () => {
  for (const operation of [
    (workspace, id) => workspace.setEnabled(id, false, { includeDependents: true }),
    (workspace, id) => workspace.remove(id, { includeDependents: true }),
  ]) {
    const { storage, workspace, runtime } = dependencyWorkspace();
    const before = structuredClone(workspace.state);
    storage.setItem = () => { throw new Error("storage full"); };
    assert.throws(() => operation(workspace, runtime.id), /could not save/);
    assert.deepEqual(workspace.state, before);
    assert.deepEqual(createManager(storage, { live: true }).state, before);
  }
});

test("Delete anyway removes only the selected mod and preserves dependent states and other profiles", () => {
  const { storage, workspace, runtime, plugin } = dependencyWorkspace();
  workspace.setEnabled(plugin.id, false);
  const originalId = workspace.profile.id;
  const other = structuredClone(workspace.cloneProfile(originalId, "Other"));
  workspace.switchProfile(originalId);
  const original = structuredClone(workspace.profile.mods);

  assert.deepEqual(workspace.remove(runtime.id, { force: true, includeDependents: true }), [runtime.id]);
  assert.deepEqual(workspace.profile.mods.map(({ id, version, enabled, package: mod }) => ({ id, version, enabled, package: mod })),
    original.filter(entry => entry.id !== runtime.id));
  assert.deepEqual(workspace.profiles.find(profile => profile.id === other.id), other);
  assert.equal(workspace.profile.mods.find(entry => entry.id === plugin.id).enabled, false);
  assert.deepEqual(createManager(storage, { live: true }).profile, workspace.profile);
});

test("forced missing dependencies survive sharing and warn before enabling transitive dependents", () => {
  const { storage, workspace, runtime, helper, plugin, packages } = dependencyWorkspace();
  workspace.remove(runtime.id, { force: true });
  workspace.registerPackages([runtime]);
  workspace.setEnabled(plugin.id, false);
  for (const manager of [workspace, createManager(storage, { live: true })]) {
    const requirements = manager.getToggleRequirements(plugin.id, true);
    assert.deepEqual(requirements.missingDependencies.map(mod => [mod.id, mod.name]), [[runtime.id, "Runtime"]]);
    assert.deepEqual(requirements.dependencies, []);
    assert.throws(() => manager.setEnabled(plugin.id, true, { includeDependencies: true }), /Install Runtime before enabling Plugin/);
  }
  assert.deepEqual(workspace.setEnabled(plugin.id, true, { force: true }), [plugin.id]);
  assert.equal(workspace.profile.mods.find(entry => entry.id === helper.id).enabled, true);
  assert.equal(workspace.profile.mods.some(entry => entry.id === runtime.id), false);
  const targetStorage = memoryStorage();
  const target = createManager(targetStorage, { live: true });
  const profile = target.importProfile(workspace.exportProfile().code, packages.filter(mod => mod.id !== runtime.id));
  assert.deepEqual(profile.mods, workspace.profile.mods);
  assert.deepEqual(createManager(targetStorage, { live: true }).profile, profile);
});

test("unrelated downloads preserve deleted requirements and reinstalling one repairs its acknowledgements", () => {
  const { storage, workspace, runtime, plugin, unrelated } = dependencyWorkspace();
  workspace.remove(runtime.id, { force: true });
  const added = thunderstorePackage("NewUnrelated", "1.0.0");
  const updated = { ...unrelated, version: "1.1.0" };
  workspace.recordDownloads(workspace.profile.id, gameId, [added, updated], [added.id, updated.id]);
  assert.equal(workspace.profile.mods.some(entry => entry.id === runtime.id), false);
  assert.deepEqual(workspace.getToggleRequirements(plugin.id, true).missingDependencies.map(mod => mod.id), [runtime.id]);
  assert.deepEqual(createManager(storage, { live: true }).profile, workspace.profile);

  workspace.recordDownloads(workspace.profile.id, gameId, [runtime], [runtime.id]);
  assert.deepEqual(workspace.getToggleRequirements(plugin.id, true).missingDependencies, []);
  assert.equal(workspace.profile.mods.some(entry => entry.missingDependencies?.includes(runtime.id)), false);
  assert.deepEqual(createManager(storage, { live: true }).profile, workspace.profile);
});

test("missing dependency acknowledgements do not permit malformed, unacknowledged, or outdated requirements", () => {
  const { workspace, runtime, helper, unrelated } = dependencyWorkspace();
  workspace.remove(runtime.id, { force: true });
  const payload = JSON.parse(workspace.exportProfile().json);
  const target = createManager(memoryStorage(), { live: true });
  const withoutAcknowledgement = structuredClone(payload);
  delete withoutAcknowledgement.mods.find(entry => entry.id === helper.id).missingDependencies;
  assert.throws(() => target.readImport(JSON.stringify(withoutAcknowledgement)), /Helper requires Runtime/);
  for (const marker of [runtime.id, [unrelated.id], [runtime.id, runtime.id]]) {
    const invalid = structuredClone(payload);
    invalid.mods.find(entry => entry.id === helper.id).missingDependencies = marker;
    assert.throws(() => target.readImport(JSON.stringify(invalid)), /invalid|dependency/i);
  }
  const outdated = structuredClone(payload);
  outdated.mods.push({ id: runtime.id, version: "0.9.0", enabled: true, package: { ...runtime, version: "0.9.0" } });
  assert.throws(() => target.readImport(JSON.stringify(outdated)), /requires Runtime/);
  assert.deepEqual(target.installed, []);
});

test("sample Delete anyway preserves surviving configurations and repairs its override on reinstall", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage);
  workspace.createProfile("Forced removal configs");
  workspace.install("morecompany");
  workspace.install("skinwalkers");
  workspace.saveConfig("morecompany", "Max Players = 12");
  workspace.saveConfig("skinwalkers", "Voice Chance = 0.5");
  const configs = structuredClone(workspace.profile.configs);
  assert.deepEqual(workspace.remove("bepinexpack", { force: true }), ["bepinexpack"]);
  assert.deepEqual(workspace.profile.configs, configs);
  assert.deepEqual(createManager(storage).profile, workspace.profile);
  assert.deepEqual(workspace.readImport(workspace.exportProfile().code).mods, workspace.profile.mods);
  workspace.remove("morecompany", { force: true });
  assert.deepEqual(workspace.profile.configs, { skinwalkers: configs.skinwalkers });
  workspace.install("bepinexpack");
  assert.equal(workspace.profile.mods.some(entry => entry.missingDependencies?.length), false);
  assert.deepEqual(createManager(storage).profile, workspace.profile);
});

test("Delete anyway validates options and rolls back when saving fails", () => {
  const { storage, workspace, runtime } = dependencyWorkspace();
  const before = structuredClone(workspace.state);
  assert.throws(() => workspace.remove(runtime.id, { force: "yes" }), /valid removal/);
  assert.deepEqual(workspace.state, before);
  storage.setItem = () => { throw new Error("storage full"); };
  assert.throws(() => workspace.remove(runtime.id, { force: true }), /could not save/);
  assert.deepEqual(workspace.state, before);
  assert.deepEqual(createManager(storage, { live: true }).state, before);
});

test("downloads and updates preserve existing forced dependency choices", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const runtime = thunderstorePackage("Runtime", "1.0.0");
  const plugin = thunderstorePackage("Plugin", "1.0.0", [runtime]);
  workspace.recordDownloads(workspace.profile.id, gameId, [runtime, plugin], [plugin.id]);
  workspace.setEnabled(runtime.id, false, { force: true });
  const unrelated = thunderstorePackage("Unrelated", "1.0.0");
  workspace.recordDownloads(workspace.profile.id, gameId, [unrelated], [unrelated.id]);
  assert.equal(workspace.installed.find(entry => entry.id === runtime.id).enabled, false);
  const added = thunderstorePackage("Added", "1.0.0");
  const updatedPlugin = { ...plugin, version: "1.1.0", dependencies: [runtime, added] };
  workspace.recordDownloads(workspace.profile.id, gameId, [runtime, added, updatedPlugin], [plugin.id]);
  assert.equal(workspace.installed.find(entry => entry.id === runtime.id).enabled, false);
  assert.equal(workspace.installed.find(entry => entry.id === added.id).enabled, true);
  const newPlugin = thunderstorePackage("NewPlugin", "1.0.0", [runtime]);
  workspace.recordDownloads(workspace.profile.id, gameId, [runtime, newPlugin], [newPlugin.id]);
  assert.equal(workspace.installed.find(entry => entry.id === runtime.id).enabled, true);
});

test("sample profile JSON and share codes round-trip Unicode configurations", () => {
  const workspace = createManager(memoryStorage());
  const name = "Café Crew";
  const text = "Message = café ☕";
  workspace.renameProfile(workspace.profile.id, name);
  workspace.saveConfig("morecompany", text);
  const { code, json, filename } = workspace.exportProfile();
  assert.match(code, /^MR1-/);
  assert.equal(filename, "lethal-company-caf-crew.ember.json");

  for (const [input, expectedName] of [[code, `${name} (2)`], [json, `${name} (3)`]]) {
    const imported = workspace.importProfile(input);
    assert.equal(imported.name, expectedName);
    assert.equal(imported.configs.morecompany, text);
    assert.equal(imported.id, workspace.profile.id);
    assert.equal(imported.mods.find(mod => mod.id === "betteritemscan").enabled, false);
  }
});

test("sample and Thunderstore workspaces persist independent profiles and settings", () => {
  const storage = memoryStorage();
  const sample = createManager(storage);
  const live = createManager(storage, { live: true });
  assert.ok(sample.installed.length);
  assert.deepEqual(live.installed, []);

  sample.createProfile("Local");
  sample.setSetting("launchMode", "vanilla");
  live.switchGame("repo");
  const online = live.createProfile("Online");

  const reloadedSample = createManager(storage);
  const reloadedLive = createManager(storage, { live: true });
  assert.equal(reloadedSample.game.id, gameId);
  assert.equal(reloadedSample.profile.name, "Local");
  assert.equal(reloadedSample.state.settings.launchMode, "vanilla");
  assert.equal(reloadedLive.game.id, "repo");
  assert.equal(reloadedLive.profile.id, online.id);
  assert.equal(reloadedLive.state.settings.launchMode, "modded");
});

test("workspace mutations roll back when persistence fails", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  workspace.createProfile("Existing");
  const before = structuredClone(workspace.state);
  storage.setItem = () => { throw new Error("storage full"); };

  assert.throws(() => workspace.createProfile("Failed"), /could not save the workspace/);
  assert.deepEqual(workspace.state, before);
  assert.deepEqual(createManager(storage, { live: true }).state, before);
});

test("live profile rejects missing and outdated dependencies without a partial commit", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const dependency = thunderstorePackage("Runtime", "1.10.0");
  const oldDependency = thunderstorePackage("Runtime", "1.9.0");
  const plugin = thunderstorePackage("Plugin", "1.0.0", [dependency]);
  const before = structuredClone(workspace.state);

  for (const packages of [[plugin], [plugin, oldDependency]]) {
    assert.throws(() => workspace.recordDownloads(workspace.profile.id, gameId, packages, [plugin.id]), /Plugin requires Runtime/);
    assert.deepEqual(workspace.state, before);
  }

  workspace.recordDownloads(workspace.profile.id, gameId, [plugin, oldDependency, dependency], [plugin.id]);
  assert.deepEqual(workspace.installed.map(({ id, version, enabled }) => [id, version, enabled]), [
    [plugin.id, "1.0.0", true],
    [dependency.id, "1.10.0", true],
  ]);
  workspace.recordDownloads(workspace.profile.id, gameId, [oldDependency], [dependency.id]);
  assert.equal(workspace.installed.find(entry => entry.id === dependency.id).version, "1.10.0");
});

test("a live download commits to its original profile even after switching profiles", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const originalId = workspace.profile.id;
  const other = workspace.createProfile("Other");
  const plugin = thunderstorePackage("Plugin", "1.0.0");

  workspace.recordDownloads(originalId, gameId, [plugin], [plugin.id]);
  assert.equal(workspace.profile.id, other.id);
  assert.deepEqual(workspace.installed, []);
  workspace.switchProfile(originalId);
  assert.equal(workspace.installed[0].id, plugin.id);

  workspace.deleteProfile(originalId);
  assert.throws(() => workspace.recordDownloads(originalId, gameId, [plugin], [plugin.id]), /profile was removed/);
  assert.deepEqual(workspace.installed, []);
});

test("live share codes require exact archives and store metadata from Thunderstore", () => {
  const source = createManager(memoryStorage(), { live: true });
  const dependency = thunderstorePackage("Runtime", "1.2.0");
  const plugin = thunderstorePackage("Plugin", "1.0.0", [dependency]);
  source.recordDownloads(source.profile.id, gameId, [dependency, plugin], [plugin.id]);
  source.setEnabled(plugin.id, false);
  const { code, json } = source.exportProfile();

  const target = createManager(memoryStorage(), { live: true });
  const tampered = JSON.parse(json);
  assert.throws(() => target.readImport(JSON.stringify({ ...tampered, configs: { [plugin.id]: "unsafe" } })), /invalid configuration data/);
  tampered.mods.find(entry => entry.id === plugin.id).package.icon = "https://example.test/not-a-cdn.png";
  const input = JSON.stringify(tampered);
  assert.equal(target.readImport(input).mods.find(entry => entry.id === plugin.id).package.icon, "");
  assert.throws(() => target.importProfile(code, [dependency, { ...plugin, version: "2.0.0" }]), /Download Plugin before importing/);
  assert.deepEqual(target.installed, []);

  const profile = target.importProfile(input, [dependency, plugin]);
  const imported = profile.mods.find(entry => entry.id === plugin.id);
  assert.equal(imported.enabled, false);
  assert.equal(imported.package.icon, plugin.icon);
  assert.throws(() => createManager(memoryStorage()).importProfile(code), /Open the Thunderstore workspace/);
  assert.throws(() => target.importProfile(createManager(memoryStorage()).exportProfile().code), /retired sample catalog/);
});

test("live update checks compare numeric versions and favorites persist offline", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const installed = thunderstorePackage("Plugin", "1.9.0");
  const latest = thunderstorePackage("Plugin", "1.10.0");
  workspace.recordDownloads(workspace.profile.id, gameId, [installed], [installed.id]);
  workspace.registerPackages([latest, installed, { ...latest, version: null }]);
  assert.equal(workspace.packageById(latest.id).version, latest.version);
  assert.deepEqual(workspace.updates.map(entry => entry.id), [latest.id]);

  workspace.toggleFavorite(latest.id);
  workspace.remove(latest.id);
  const reloaded = createManager(storage, { live: true });
  assert.deepEqual(reloaded.state.favorites, [latest.id]);
  assert.equal(reloaded.packageById(latest.id).version, latest.version);
});

test("known mod updates survive restarting and switching profiles without changing installed data", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const mod = thunderstorePackage("Plugin", "1.9.0");
  const profileId = workspace.profile.id;
  workspace.recordDownloads(profileId, gameId, [mod], [mod.id]);
  workspace.setEnabled(mod.id, false);
  const originalExport = workspace.exportProfile().json;
  workspace.registerPackages([{ ...mod, version: "1.10.0" }], { checkedLatest: true });

  workspace.createProfile("Another profile");
  assert.deepEqual(workspace.updates, []);
  const reloaded = createManager(storage, { live: true });
  reloaded.switchProfile(profileId);
  reloaded.registerPackages([mod, { ...mod, version: null }]);
  const [update] = reloaded.updates;
  assert.equal(update.latestVersion, "1.10.0");
  assert.equal(update.version, "1.9.0");
  assert.equal(update.mod.version, "1.9.0");
  assert.equal(update.enabled, false);
  assert.equal(reloaded.exportProfile().json, originalExport);

  reloaded.switchGame("repo");
  const otherGameMod = thunderstorePackage("Plugin", "1.9.0", [], "repo");
  reloaded.recordDownloads(reloaded.profile.id, "repo", [otherGameMod], [otherGameMod.id]);
  assert.deepEqual(reloaded.updates, []);
  reloaded.switchGame(gameId);
  assert.equal(reloaded.updates[0].latestVersion, "1.10.0");
});

test("a successful version check can retract an update without replacing full package details", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const installed = thunderstorePackage("Plugin", "1.0.0");
  const latest = thunderstorePackage("Plugin", "2.0.0", [thunderstorePackage("Runtime", "3.0.0")]);
  workspace.recordDownloads(workspace.profile.id, gameId, [installed], [installed.id]);
  workspace.registerPackages([latest]);
  workspace.registerPackages([{ ...latest, dependencies: [] }], { checkedLatest: true });
  assert.equal(workspace.packageById(installed.id).dependencies[0].name, "Runtime");
  assert.equal(workspace.updates[0].latestVersion, "2.0.0");

  workspace.registerPackages([installed], { checkedLatest: true });
  workspace.registerPackages([latest]);
  assert.deepEqual(workspace.updates, []);
  assert.deepEqual(createManager(storage, { live: true }).updates, []);
});

test("catalog versions become durable once installed and are discarded after the last profile removes them", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const mod = thunderstorePackage("Plugin", "1.0.0");
  const latest = { ...mod, version: "2.0.0" };
  const source = createManager(memoryStorage(), { live: true });
  source.recordDownloads(source.profile.id, gameId, [mod], [mod.id]);

  workspace.registerPackages([latest, thunderstorePackage("Uninstalled", "9.0.0")]);
  assert.equal(storage.getItem(latestVersionsKey), null);
  const imported = workspace.importProfile(source.exportProfile().code, [mod]);
  const reloaded = createManager(storage, { live: true });
  assert.equal(reloaded.updates[0].latestVersion, "2.0.0");
  const copy = reloaded.cloneProfile(imported.id, "Copy");
  reloaded.remove(mod.id);
  reloaded.switchProfile(imported.id);
  assert.equal(reloaded.updates[0].latestVersion, "2.0.0");
  reloaded.deleteProfile(imported.id);
  reloaded.switchProfile(copy.id);
  assert.deepEqual(JSON.parse(storage.getItem(latestVersionsKey)), []);
});

test("invalid cache entries and failed cache writes leave installed packages usable", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const mod = thunderstorePackage("Plugin", "1.0.0");
  workspace.recordDownloads(workspace.profile.id, gameId, [mod], [mod.id]);
  storage.setItem(latestVersionsKey, JSON.stringify([[mod.id, "invalid"], ["unknown", "99.0.0"], null]));
  const reloaded = createManager(storage, { live: true });
  assert.equal(reloaded.installed[0].latestVersion, "1.0.0");

  let cacheWrites = 0;
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === latestVersionsKey) {
      cacheWrites++;
      throw new Error("storage full");
    }
    setItem(key, value);
  };
  const latest = { ...mod, version: "2.0.0" };
  reloaded.registerPackages([latest], { checkedLatest: true });
  reloaded.registerPackages([latest], { checkedLatest: true });
  assert.equal(cacheWrites, 1);
  assert.equal(reloaded.updates[0].latestVersion, "2.0.0");
  reloaded.setEnabled(mod.id, false);
  assert.equal(reloaded.updates[0].enabled, false);
  assert.equal(createManager(storage, { live: true }).installed[0].enabled, false);
});

test("package tags and status survive installed profile reloads and sharing", () => {
  const storage = memoryStorage();
  const workspace = createManager(storage, { live: true });
  const mod = { ...thunderstorePackage("Tagged", "1.0.0"), category: "Gameplay",
    categories: [{ id: "19", name: "Gameplay" }, { id: "20", name: "Client-side" }], deprecated: true, pinned: true, nsfw: false };
  workspace.recordDownloads(workspace.profile.id, gameId, [mod], [mod.id]);
  const reloaded = createManager(storage, { live: true });
  assert.deepEqual(reloaded.installed[0].mod.categories, mod.categories);
  assert.equal(reloaded.installed[0].mod.deprecated, true);
  assert.equal(reloaded.installed[0].mod.pinned, true);
  const exported = reloaded.exportProfile();
  const target = createManager(memoryStorage(), { live: true });
  target.importProfile(exported.code, [mod]);
  assert.deepEqual(target.installed[0].mod.categories, mod.categories);
  assert.equal(target.installed[0].mod.deprecated, true);
});

test("fresh catalog status updates installed badges without changing the installed version or dependencies", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const installed = thunderstorePackage("Plugin", "1.0.0");
  workspace.recordDownloads(workspace.profile.id, gameId, [installed], [installed.id]);
  const category = { id: "20", name: "Client-side" };
  workspace.registerPackages([{ ...installed, version: "2.0.0", categories: [category], deprecated: true, pinned: true }]);
  const entry = workspace.installed[0];
  assert.equal(entry.version, "1.0.0");
  assert.equal(entry.mod.version, "1.0.0");
  assert.equal(entry.hasUpdate, true);
  assert.deepEqual(entry.mod.dependencies, []);
  assert.deepEqual(entry.mod.categories, [category]);
  assert.equal(entry.mod.deprecated, true);
  assert.equal(entry.mod.pinned, true);
});

test("category metadata is optional for old profiles and validates bounded labels and IDs", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const mod = thunderstorePackage("Plugin", "1.0.0");
  workspace.registerPackages([{ ...mod, categories: [{ id: "19", name: "  Gameplay  " }, { id: "19", name: "Updated" },
    { id: "../unsafe", name: "Unsafe" }, { id: "20", name: " " }, { id: "21", name: "x".repeat(150) }], pinned: "true", nsfw: 1 }]);
  const normalized = workspace.packageById(mod.id);
  assert.deepEqual(normalized.categories, [{ id: "19", name: "Updated" }, { id: "21", name: "x".repeat(100) }]);
  assert.equal(normalized.pinned, false);
  assert.equal(normalized.nsfw, false);
  workspace.recordDownloads(workspace.profile.id, gameId, [mod], [mod.id]);
  assert.deepEqual(workspace.profile.mods[0].package.categories, []);
});

test("imported configuration files survive profile reload, cloning, and Ember exports", () => {
  const source = createManager(memoryStorage(), { live: true });
  const mod = thunderstorePackage("Configured", "1.0.0");
  source.recordDownloads(source.profile.id, gameId, [mod], [mod.id]);
  const payload = JSON.parse(source.exportProfile().json);
  payload.configFiles = { "crew/settings.json": '{"crew":"café ☕"}', "example.cfg": "Enabled = true\r\n" };
  const storage = memoryStorage();
  const target = createManager(storage, { live: true });
  const profile = target.importProfile(JSON.stringify(payload), [mod]);
  assert.deepEqual(profile.configFiles, payload.configFiles);
  assert.deepEqual(createManager(storage, { live: true }).profile.configFiles, payload.configFiles);
  const clone = target.cloneProfile(profile.id, "Copy");
  assert.deepEqual(clone.configFiles, payload.configFiles);
  assert.notEqual(clone.configFiles, profile.configFiles);
  const exported = target.exportProfile(clone.id);
  assert.deepEqual(target.readImport(exported.code).configFiles, payload.configFiles);
  assert.deepEqual(JSON.parse(exported.json).configFiles, payload.configFiles);
  delete payload.configFiles;
  assert.deepEqual(target.readImport(JSON.stringify(payload)).configFiles, {}, "Old exports remain importable.");
});

test("invalid imported configuration files cannot create a partial profile", () => {
  const workspace = createManager(memoryStorage(), { live: true });
  const payload = JSON.parse(workspace.exportProfile().json);
  const original = workspace.profiles.length;
  for (const configFiles of [null, [], { "../escape.cfg": "unsafe" }, { "run.dll": "executable" },
    { "NUL.cfg": "reserved" }, { "file.cfg": "binary\0text" }, { "Case.cfg": "a", "case.cfg": "b" },
    { "dir/file.cfg": "a", "DIR/other.cfg": "b" }, { "file.cfg": "é".repeat(128 * 1024 + 1) }]) {
    assert.throws(() => workspace.importProfile(JSON.stringify({ ...payload, configFiles })), /configuration|Configuration/);
    assert.equal(workspace.profiles.length, original);
  }
});

test("MIMESIS UserData configurations survive imports, reloads, clones, game changes and sharing", () => {
  const source = createManager(memoryStorage(), { live: true });
  source.switchGame("mimesis");
  assert.equal(source.game.name, "MIMESIS");
  const loader = { ...thunderstorePackage("MelonLoader", "0.7.3", [], "mimesis"), namespace: "LavaGang", author: "LavaGang", id: "mimesis/LavaGang/MelonLoader" };
  source.recordDownloads(source.profile.id, "mimesis", [loader], [loader.id]);
  const payload = JSON.parse(source.exportProfile().json);
  payload.userDataFiles = { "MelonPreferences.cfg": "Crew = café ☕", "Nested/settings.json": '{"enabled":true}' };
  const storage = memoryStorage();
  const target = createManager(storage, { live: true });
  const imported = target.importProfile(JSON.stringify(payload), [loader]);
  assert.equal(imported.gameId, "mimesis");
  assert.deepEqual(imported.userDataFiles, payload.userDataFiles);
  assert.deepEqual(createManager(storage, { live: true }).profile.userDataFiles, payload.userDataFiles);
  const cloned = target.cloneProfile(imported.id, "MIMESIS copy");
  assert.deepEqual(cloned.userDataFiles, payload.userDataFiles);
  assert.notEqual(cloned.userDataFiles, imported.userDataFiles);
  const exported = target.exportProfile(cloned.id);
  assert.deepEqual(target.readImport(exported.code).userDataFiles, payload.userDataFiles);
  target.switchGame("repo");
  assert.deepEqual(target.profile.userDataFiles, {});
  target.switchGame("mimesis");
  assert.deepEqual(target.profile.userDataFiles, payload.userDataFiles);
  delete payload.userDataFiles;
  assert.deepEqual(target.readImport(JSON.stringify(payload)).userDataFiles, {});
});

test("invalid UserData paths cannot partially import a MIMESIS profile", () => {
  const target = createManager(memoryStorage(), { live: true });
  target.switchGame("mimesis");
  const payload = JSON.parse(target.exportProfile().json);
  const before = target.profiles.length;
  for (const userDataFiles of [null, [], { "../outside.cfg": "x" }, { "executable.dll": "x" },
    { "NUL.cfg": "x" }, { "test.cfg": "x\0y" }, { "Test.cfg": "x", "test.cfg": "y" }]) {
    assert.throws(() => target.importProfile(JSON.stringify({ ...payload, userDataFiles })), /configuration|Configuration/);
    assert.equal(target.profiles.length, before);
  }
});

test("existing workspaces gain a MIMESIS default profile without resetting other profiles or wallpaper", () => {
  const storage = memoryStorage();
  const manager = createManager(storage, { live: true });
  manager.createProfile("Existing friends");
  manager.setSetting("wallpaper", "obsidian");
  const saved = JSON.parse(storage.getItem("modrelay:thunderstore:v1"));
  saved.profiles = saved.profiles.filter(profile => profile.gameId !== "mimesis");
  delete saved.activeProfileIds.mimesis;
  for (const profile of saved.profiles) delete profile.userDataFiles;
  storage.setItem("modrelay:thunderstore:v1", JSON.stringify(saved));
  const reloaded = createManager(storage, { live: true });
  assert.equal(reloaded.profile.name, "Existing friends");
  assert.equal(reloaded.state.settings.wallpaper, "obsidian");
  reloaded.switchGame("mimesis");
  assert.equal(reloaded.profile.id, "mimesis-default");
  assert.deepEqual(reloaded.profile.userDataFiles, {});
  assert.equal(reloaded.state.settings.wallpaper, "obsidian");
});

