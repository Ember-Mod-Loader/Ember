# Ember 0.5.3

- Improved online-count consistency across quick closes and restarts using a short-lived local session lease and connection ownership. The lease stays valid for 120 seconds between renewals; inactive online sessions still expire after 90 seconds.
- Closed-session retirement records reject delayed requests without contributing to the online count.
- Closing Ember now coordinates a bounded presence cleanup before quitting. Failed or stalled cleanup cannot keep the app open indefinitely, and reopening during cleanup queues a fresh launch.
- Added update-handoff reliability safeguards: cached installers for the same or an older version are ignored, and repeated automatic restarts pause when an earlier handoff may not have completed. Manual **Install and restart** remains available.
- Automatic updates now show clear restart feedback before installation begins. Blocked or failed handoffs restore the normal controls.
- Added bounded local diagnostic logs for investigating startup, shutdown, updater, and process failures. Logs remain on the device and are not uploaded.

Installed clients receive this update through **Settings → Update client** or the automatic startup check. Portable users can download a replacement from the [latest release](https://github.com/Ember-Mod-Loader/Ember/releases/latest).

Both Windows builds are unsigned. Existing profiles and preferences are preserved.
