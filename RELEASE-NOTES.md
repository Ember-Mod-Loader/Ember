# Ember 0.6.0

- Added **MIMESIS** with its Thunderstore catalog, official game icon, Steam detection, profiles, and modded or vanilla launching through MelonLoader.
- Added MelonLoader 0.7+ profile support, including recursive mods, plugins, libraries, UserData imports, and managed loader updates.
- Expanded BepInEx installation support for bare core folders, MonoMod patches, package wrappers, and explicit game-root or game-data files.
- Game-root replacements are backed up and restored when another profile starts, vanilla launches, or Ember's loader is removed. Edited mod files are preserved in a recovery folder.
- Packages for incompatible loaders and ambiguous archive layouts now show the affected path instead of being silently placed in the plugins folder.
- Fixed imports of Windows Thunderstore profiles whose configuration paths use backslashes.
- Compatible existing loaders are reused directly when launching, without another confirmation dialog.
- The launch button shows **Starting…** or **Running**, blocks duplicate launches, and returns to normal when the game closes.

Installed clients receive this update through **Settings → Update client** or the automatic startup check. Existing profiles and preferences are preserved.

Windows builds are currently unsigned.
