// Keep published codes valid when their rewards become available to everyone.
const CODES = Object.freeze({
  FIRSTFLAME: Object.freeze({ id: "first-flame", wallpaperId: "first-flame" }),
});

export const REWARD_WALLPAPERS = Object.freeze([]);

export function readRewardCode(value) {
  if (typeof value !== "string" || value.length > 64) throw new Error("Enter a code up to 64 characters.");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,48}$/.test(code)) throw new Error("Enter a valid code.");
  if (!Object.hasOwn(CODES, code)) throw new Error("That code wasn't found. Check it and try again.");
  return CODES[code];
}

export function readUnlockedRewards(value) {
  if (!Array.isArray(value)) return [];
  const known = new Set(REWARD_WALLPAPERS.map(wallpaper => wallpaper.rewardId));
  return [...new Set(value.slice(0, 100).filter(id => typeof id === "string" && known.has(id)))];
}
