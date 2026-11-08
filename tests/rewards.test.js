import assert from "node:assert/strict";
import test from "node:test";
import { createManager } from "../src/model.js";

const key = "modrelay:thunderstore:v1";
function storage() {
  const values = new Map();
  let writes = 0;
  return {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes++; values.set(key, value); },
    get writes() { return writes; },
  };
}

test("First Flame is available without a code and stays selected across profiles, games and reloads", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  assert.equal(manager.wallpapers.length, 6);
  assert(manager.wallpapers.some(wallpaper => wallpaper.id === "first-flame"));
  assert.equal(manager.wallpapers.some(wallpaper => wallpaper.id === "aurora"), false);
  manager.setSetting("wallpaper", "first-flame");
  manager.createProfile("Flame crew");
  manager.switchGame("mimesis");
  assert.equal(manager.state.settings.wallpaper, "first-flame");
  manager.switchGame("lethal-company");
  assert.equal(manager.profile.name, "Flame crew");
  const reloaded = createManager(saved, { live: true });
  assert.equal(reloaded.state.settings.wallpaper, "first-flame");
  assert.deepEqual(reloaded.state.unlockedRewards, []);
  assert(reloaded.wallpapers.some(wallpaper => wallpaper.id === "first-flame"));
  const choices = reloaded.wallpapers;
  choices.find(wallpaper => wallpaper.id === "first-flame").name = "Changed result";
  assert.equal(reloaded.wallpapers.find(wallpaper => wallpaper.id === "first-flame").name, "First Flame");
});

test("the legacy First Flame code reports already unlocked without changing or writing the workspace", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  manager.setSetting("wallpaper", "obsidian");
  const before = structuredClone(manager.state);
  const writes = saved.writes;
  for (const code of ["  firstflame  ", "FIRSTFLAME"]) {
    const result = manager.redeemCode(code);
    assert.equal(result.status, "already-unlocked");
    assert.equal(result.wallpaper.id, "first-flame");
    result.wallpaper.name = "Changed result";
  }
  assert.equal(saved.writes, writes);
  assert.deepEqual(manager.state, before);
  saved.setItem = () => { throw new Error("Disk full"); };
  assert.equal(manager.redeemCode("FIRSTFLAME").status, "already-unlocked");
  assert.equal(manager.wallpapers.find(wallpaper => wallpaper.id === "first-flame").name, "First Flame");
  assert.deepEqual(manager.state, before);
});

test("invalid or oversized codes leave the workspace unchanged", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  const before = structuredClone(manager.state);
  const writes = saved.writes;
  for (const value of [undefined, null, {}, [], 10, "", " ", "FIRST FLAME", "FIRSTFLAME\nOTHER", "UNKNOWN", "__proto__", "toString", "x".repeat(65), " ".repeat(65) + "FIRSTFLAME"]) {
    assert.throws(() => manager.redeemCode(value), /code/i);
    assert.deepEqual(manager.state, before);
  }
  assert.equal(saved.writes, writes);
});

test("profile sharing leaves wallpaper preferences and reward state on each client", () => {
  const source = createManager(storage(), { live: true });
  source.setSetting("wallpaper", "first-flame");
  const exported = source.exportProfile();
  const payload = JSON.parse(exported.json);
  assert.equal(Object.hasOwn(payload, "unlockedRewards"), false);
  assert.equal(Object.hasOwn(payload, "settings"), false);
  const target = createManager(storage(), { live: true });
  payload.unlockedRewards = ["first-flame"];
  payload.settings = { wallpaper: "first-flame" };
  target.importProfile(JSON.stringify(payload));
  assert.deepEqual(target.state.unlockedRewards, []);
  assert.equal(target.state.settings.wallpaper, "main");
  assert.equal(target.wallpapers.length, 6);
  target.setSetting("wallpaper", "first-flame");
  assert.equal(target.state.settings.wallpaper, "first-flame");
});

test("saved Aurora selections fall back to Main without resetting profiles or other preferences", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  manager.createProfile("Existing crew");
  manager.setSetting("launchMode", "vanilla");
  manager.setSetting("compactMode", true);
  const old = JSON.parse(saved.getItem(key));
  old.settings.wallpaper = "aurora";
  delete old.unlockedRewards;
  saved.setItem(key, JSON.stringify(old));
  const reloaded = createManager(saved, { live: true });
  assert.equal(reloaded.profile.name, "Existing crew");
  assert.deepEqual(reloaded.state.profiles, old.profiles);
  assert.deepEqual(reloaded.state.activeProfileIds, old.activeProfileIds);
  assert.equal(reloaded.state.settings.wallpaper, "main");
  assert.equal(reloaded.state.settings.launchMode, "vanilla");
  assert.equal(reloaded.state.settings.compactMode, true);
  assert.deepEqual(reloaded.state.unlockedRewards, []);
  assert.throws(() => reloaded.setSetting("wallpaper", "aurora"), /not supported/);
});

test("previous First Flame selections survive missing, malformed or retired reward records", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  manager.createProfile("Existing crew");
  manager.setSetting("wallpaper", "first-flame");
  const old = JSON.parse(saved.getItem(key));
  for (const value of [undefined, {}, "first-flame", ["unknown", 4], ["unknown", "first-flame", "first-flame"]]) {
    saved.setItem(key, JSON.stringify({ ...old, unlockedRewards: value }));
    const reloaded = createManager(saved, { live: true });
    assert.equal(reloaded.profile.name, "Existing crew");
    assert.equal(reloaded.state.settings.wallpaper, "first-flame");
    assert.deepEqual(reloaded.state.unlockedRewards, []);
    const writes = saved.writes;
    assert.equal(reloaded.redeemCode("FIRSTFLAME").status, "already-unlocked");
    assert.equal(saved.writes, writes);
  }
});
