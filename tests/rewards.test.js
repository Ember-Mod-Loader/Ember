import assert from "node:assert/strict";
import test from "node:test";
import { createManager } from "../src/model.js";

const key = "modrelay:thunderstore:v1";
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("wallpaper codes unlock an exclusive reward across profiles, games and reloads", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  assert.equal(manager.wallpapers.length, 6);
  assert.throws(() => manager.setSetting("wallpaper", "first-flame"), /Unlock this wallpaper/);
  const reward = manager.redeemCode("  firstflame  ");
  assert.equal(reward.status, "unlocked");
  assert.equal(reward.wallpaper.id, "first-flame");
  assert.equal(manager.wallpapers.length, 7);
  manager.setSetting("wallpaper", reward.wallpaper.id);
  manager.createProfile("Reward crew");
  manager.switchGame("mimesis");
  assert.equal(manager.state.settings.wallpaper, "first-flame");
  manager.switchGame("lethal-company");
  assert.equal(manager.profile.name, "Reward crew");
  const reloaded = createManager(saved, { live: true });
  assert.equal(reloaded.state.settings.wallpaper, "first-flame");
  assert.deepEqual(reloaded.state.unlockedRewards, ["first-flame"]);
  assert(reloaded.wallpapers.some(wallpaper => wallpaper.id === "first-flame"));
  const before = saved.getItem(key);
  assert.equal(reloaded.redeemCode("FIRSTFLAME").status, "already-unlocked");
  assert.equal(saved.getItem(key), before, "Redeeming twice must not create another unlock or write.");
  reward.wallpaper.name = "Changed result";
  assert.equal(manager.wallpapers.find(wallpaper => wallpaper.id === "first-flame").name, "First Flame");
});

test("invalid or oversized codes leave the workspace unchanged", () => {
  const manager = createManager(storage(), { live: true });
  const before = structuredClone(manager.state);
  for (const value of [undefined, null, {}, [], 10, "", " ", "FIRST FLAME", "FIRSTFLAME\nOTHER", "UNKNOWN", "__proto__", "toString", "x".repeat(65), " ".repeat(65) + "FIRSTFLAME"]) {
    assert.throws(() => manager.redeemCode(value), /code/i);
    assert.deepEqual(manager.state, before);
  }
});

test("reward unlocks cannot travel through shared or imported profiles", () => {
  const source = createManager(storage(), { live: true });
  source.redeemCode("FIRSTFLAME");
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
  assert.throws(() => target.setSetting("wallpaper", "first-flame"), /Unlock this wallpaper/);
});

test("failed redemption saves roll back unlocks and leave existing wallpaper choices intact", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  manager.setSetting("wallpaper", "aurora");
  const before = structuredClone(manager.state);
  saved.setItem = () => { throw new Error("Disk full"); };
  assert.throws(() => manager.redeemCode("FIRSTFLAME"), /could not save/);
  assert.deepEqual(manager.state, before);
  assert.equal(manager.wallpapers.length, 6);
});

test("old and malformed saved reward preferences migrate without resetting profiles", () => {
  const saved = storage();
  const manager = createManager(saved, { live: true });
  manager.createProfile("Existing crew");
  manager.setSetting("wallpaper", "aurora");
  const old = JSON.parse(saved.getItem(key));
  delete old.unlockedRewards;
  saved.setItem(key, JSON.stringify(old));
  let reloaded = createManager(saved, { live: true });
  assert.equal(reloaded.profile.name, "Existing crew");
  assert.equal(reloaded.state.settings.wallpaper, "aurora");
  assert.deepEqual(reloaded.state.unlockedRewards, []);
  for (const value of [undefined, {}, "first-flame", ["unknown", 4]]) {
    saved.setItem(key, JSON.stringify({ ...old, unlockedRewards: value, settings: { ...old.settings, wallpaper: "first-flame" } }));
    reloaded = createManager(saved, { live: true });
    assert.equal(reloaded.profile.name, "Existing crew");
    assert.equal(reloaded.state.settings.wallpaper, "main");
    assert.deepEqual(reloaded.state.unlockedRewards, []);
  }
  saved.setItem(key, JSON.stringify({ ...old, unlockedRewards: ["unknown", "first-flame", "first-flame"], settings: { ...old.settings, wallpaper: "first-flame" } }));
  reloaded = createManager(saved, { live: true });
  assert.equal(reloaded.state.settings.wallpaper, "first-flame");
  assert.deepEqual(reloaded.state.unlockedRewards, ["first-flame"]);
});
