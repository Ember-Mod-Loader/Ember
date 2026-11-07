# Ember 0.5.2

- Added a live online counter in the app header, backed by Ember's anonymous presence service.
- Counts refresh about every 30 seconds. Sessions expire after 90 seconds without a heartbeat, so closed or disconnected apps do not stay counted indefinitely.
- Connection failures show an unavailable state instead of a fabricated count and retry automatically.
- Added the service source, hosting configuration, and regression coverage for shared counts, expiration, bounded requests, and disconnects.

Installed clients receive this update through **Settings → Update client** or the automatic startup check. Portable users can download a replacement from the [latest release](https://github.com/Ember-Mod-Loader/Ember/releases/latest).

Both Windows builds are unsigned. Existing profiles and preferences are preserved.
