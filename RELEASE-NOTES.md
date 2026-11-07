# Ember 0.5.6

- Added a **Thunderstore / r2modman** option in **Import profile** for native profile codes.
- Imports preserve package versions and enabled states, and download required dependencies for the selected game.
- Supported BepInEx configuration files stay with the imported profile and apply when it is prepared or launched.
- Archives with unsupported file locations show a review step before importing supported data. Existing Ember codes and JSON imports remain available.
- Fixed search refreshes resetting the cursor or selection while typing.
- Added support for shared BepInEx core libraries, including OdinSerializer, while preserving loader-file collision checks.

Installed clients receive this update through **Settings → Update client** or the automatic startup check. Portable users can download a replacement from the [latest release](https://github.com/Ember-Mod-Loader/Ember/releases/latest).

Both Windows builds are unsigned. Existing profiles and preferences are preserved.
