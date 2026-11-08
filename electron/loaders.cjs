const SUPPORTED = new Set(['lethal-company', 'repo', 'peak', 'mimesis']);

function chooseLoader(refs, gameId) {
  if (!SUPPORTED.has(gameId)) throw new Error('Choose a supported game.');
  const melon = refs.find(ref => ref.namespace === 'LavaGang' && ref.name === 'MelonLoader');
  const bepinexName = gameId === 'peak' ? 'BepInExPack_PEAK' : 'BepInExPack';
  const bepinex = refs.find(ref => ref.namespace === 'BepInEx' && ref.name === bepinexName);
  const otherBepinex = refs.some(ref => ref.namespace === 'BepInEx' && /^BepInExPack(?:_|$)/.test(ref.name));
  if (melon && otherBepinex) throw new Error('BepInEx and MelonLoader cannot run in the same profile. Disable the other loader and its mods.');
  if (gameId === 'mimesis' && bepinex) throw new Error('MIMESIS uses MelonLoader. Install and enable LavaGang MelonLoader for this profile.');
  if (melon) {
    const [major, minor] = melon.version.split('.').map(Number);
    if (major === 0 && minor < 7) throw new Error('Ember requires MelonLoader 0.7.0 or newer for isolated profiles.');
    return { kind: 'melonloader', ref: melon, name: 'MelonLoader' };
  }
  if (bepinex) return { kind: 'bepinex', ref: bepinex, name: bepinexName };
  throw new Error(`Download and enable ${gameId === 'mimesis' ? 'MelonLoader' : bepinexName} in this profile.`);
}

module.exports = { chooseLoader };
