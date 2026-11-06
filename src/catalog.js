const GAME_DETAILS = [
  ["lethal-company", "Lethal Company", "LC", "1966720", "#df7744", "Co-op scavenging on abandoned moons"],
  ["repo", "R.E.P.O.", "RE", "3241660", "#f07c59", "Physics-based horror and hazardous retrieval"],
  ["peak", "PEAK", "PK", "3527290", "#e6bd58", "Co-op climbing and survival on a mysterious island"],
  ["valheim", "Valheim", "VH", "892970", "#6bbb87", "Viking survival in a sprawling world"],
  ["risk-of-rain-2", "Risk of Rain 2", "RR", "632360", "#7c91ff", "An action roguelike with escalating risk"],
];

export const GAMES = GAME_DETAILS.map(([id, name, shortName, steamId, color, description]) => ({
  id, name, shortName, steamId, color, description,
  icon: `./art/game-${id}.${['lethal-company', 'repo', 'peak'].includes(id) ? 'jpg' : 'svg'}`,
}));

const COMPANY = "lethal-company";

const PACKAGE_DETAILS = [
  ["latecompany", "LateCompany", "anormaltwig", "Let friends join your crew after a round has already started.", "Gameplay", "1.0.18", 2860000, 391, "#a16fe8", ["bepinexpack"]],
  ["morecompany", "MoreCompany", "notnotnotswipez", "Bring a bigger crew and customize your look with extra cosmetics.", "Gameplay", "1.11.2", 20400000, 1260, "#e48b47", ["bepinexpack"]],
  ["skinwalkers", "Skinwalkers", "RugbugRedfern", "Enemies borrow your friends’ voices for a more unsettling shift.", "Audio", "5.0.0", 12900000, 827, "#63bd93", ["bepinexpack"]],
  ["reserveditemslotcore", "ReservedItemSlotCore", "FlipMods", "Adds dedicated inventory slots for compatible equipment mods.", "Libraries", "2.0.47", 19200000, 702, "#bf844e", ["bepinexpack"]],
  ["toomanyemotes", "TooManyEmotes", "FlipMods", "Build a personal collection of dances, gestures, and other emotes.", "Cosmetics", "2.2.17", 11900000, 638, "#c86693", ["bepinexpack"]],
  ["lethalexpansion", "LethalExpansion", "HolographicWings", "An expansion framework for extra moons, items, and encounters.", "Gameplay", "1.3.45", 8900000, 487, "#7375dc", ["lethallib"]],
  ["lethalconfig", "LethalConfig", "AinaVT", "Edit supported mod settings from the game’s pause menu.", "Quality of life", "1.4.6", 10700000, 623, "#569dd6", ["bepinexpack"]],
  ["betteritemscan", "BetterItemScan", "PopleZoo", "Makes it easier to see nearby loot and read item values.", "Quality of life", "3.0.2", 6200000, 405, "#46b5bd", ["bepinexpack"]],
  ["hdlethalcompany", "HDLethalCompany", "Sligili", "Tune resolution, rendering quality, and other graphics settings.", "Quality of life", "1.5.6", 7100000, 438, "#8d7de5", ["bepinexpack"]],
  ["bepinexpack", "BepInExPack", "BepInEx", "The core mod loader for Lethal Company’s plugin ecosystem.", "Libraries", "5.4.2304", 47800000, 2250, "#6180de", []],
  ["helmetcameras", "Helmet Cameras", "RickArg", "Watch live helmet feeds from the ship’s second monitor.", "Gameplay", "2.1.5", 4300000, 366, "#62aa79", ["bepinexpack"]],
  ["lethallib", "LethalLib", "Evaisa", "Shared helpers for registering items, enemies, and other content.", "Libraries", "0.16.2", 23200000, 797, "#4ba49b", ["bepinexpack"]],
  ["yippeemod", "YippeeMod", "sunnobunno", "Give the Hoarding Bug a cheerful new sound.", "Audio", "1.2.4", 3500000, 325, "#d97565", ["bepinexpack"]],
  ["shiploot", "ShipLoot", "tinyhoot", "See the combined value of the scrap aboard your ship.", "Quality of life", "1.1.0", 11800000, 601, "#ac845b", ["bepinexpack"]],
  ["repo-bepinex", "BepInExPack", "BepInEx", "The core mod loader for R.E.P.O. plugins.", "Libraries", "5.4.2305", 13200000, 861, "#f07c59", [], "repo"],
  ["repo-moreplayers", "MorePlayers", "LegoAndmars", "Make room for a larger retrieval team.", "Gameplay", "1.1.0", 4200000, 383, "#e39b6b", ["repo-bepinex"], "repo"],
  ["repo-sharedupgrades", "SharedUpgrades", "Traktool", "Share upgrade effects with everyone in the crew.", "Quality of life", "2.1.3", 2900000, 241, "#db755b", ["repo-bepinex"], "repo"],
  ["valheim-bepinex", "BepInExPack", "denikson", "The core mod loader for Valheim plugins.", "Libraries", "5.4.2333", 10000000, 815, "#6bbb87", [], "valheim"],
  ["valheim-jotunn", "Jötunn", "ValheimModding", "Shared tools for adding pieces, items, and other content.", "Libraries", "2.25.0", 5500000, 460, "#79ac9f", ["valheim-bepinex"], "valheim"],
  ["valheim-betterarchery", "BetterArchery", "ishid4", "Adds new options for bow handling, quivers, and arrows.", "Gameplay", "1.9.0", 1900000, 143, "#84a87b", ["valheim-bepinex"], "valheim"],
  ["ror2-bepinex", "BepInExPack", "bbepis", "The core mod loader for Risk of Rain 2 plugins.", "Libraries", "5.4.2121", 16800000, 964, "#7c91ff", [], "risk-of-rain-2"],
  ["ror2-r2api", "R2API", "RiskofThunder", "Shared APIs for items, characters, and other modded content.", "Libraries", "5.2.3", 7300000, 627, "#8385ce", ["ror2-bepinex"], "risk-of-rain-2"],
  ["ror2-proper-save", "ProperSave", "KingEnderBrine", "Save your run between stages and resume it later.", "Quality of life", "2.12.1", 3000000, 288, "#8277ae", ["ror2-r2api"], "risk-of-rain-2"],
];

const CONFIGS = {
  morecompany: ["MoreCompany.cfg", "[Lobby]\nMax Players = 8\n\n[Cosmetics]\nShow Cosmetics = true\n"],
  skinwalkers: ["Skinwalkers.cfg", "[Audio]\nVoice Chance = 0.25\nVoice Volume = 0.85\n"],
  betteritemscan: ["BetterItemScan.cfg", "[Scanner]\nScan Range = 24\nShow Item Value = true\n"],
  latecompany: ["LateCompany.cfg", "[Lobby]\nAllow Late Joining = true\n"],
  hdlethalcompany: ["HDLethalCompany.cfg", "[Graphics]\nResolution Scale = 1.0\nEnable Fog = true\n"],
};

export const CATALOG = PACKAGE_DETAILS.map(([id, name, author, description, category, version, downloads, rating, color, dependencies, gameId = COMPANY]) => {
  const config = CONFIGS[id];
  return {
    id, gameId, name, author, description, category, version, downloads, rating, color, dependencies,
    icon: gameId === COMPANY ? `./art/mod-${id}.svg` : `./art/game-${gameId}.svg`,
    featured: id === "latecompany",
    config: config ? { name: config[0], path: `BepInEx/config/${config[0]}`, text: config[1] } : undefined,
  };
});

const gamesById = new Map(GAMES.map(game => [game.id, game]));
const packagesById = new Map(CATALOG.map(mod => [mod.id, mod]));

export const getGame = id => gamesById.get(id);
export const getPackage = id => packagesById.get(id);
export const getCatalog = gameId => CATALOG.filter(mod => mod.gameId === gameId);
