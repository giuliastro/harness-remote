# Android notifications and battery guide

Harness Remote keeps a native `remoteMessaging` foreground service alive instead of using Google
push. The service holds one capability-scoped SSE connection per paired machine and posts local
notifications. It never reads the transcript.

## What the app needs

1. **Notification permission** on Android 13+. The app asks once during pairing. If notifications
   were disabled later, enable them from the app's system settings.
2. **Battery optimization exemption** for reliable background delivery. The app requests the standard
   Android dialog during pairing. This is the same exemption Android requires for a long-lived
   foreground service; it is not a root or ADB workaround.
3. Keep the persistent foreground notification. Android requires it while the service is connected.

The persistent notification now has a **Stop/Ferma** action. Stopping the service removes the
notification and the SSE connections; the app remains installed. Opening the app and keeping paired
machines restarts the service. Swiping the notification or the app from Recents is not a reliable way
to stop background work.

## OEM-specific settings

The exact labels vary by language and OS version. Grant notifications and remove battery
restrictions first; the other settings only help some vendors.

| Device family | Notifications | Background battery | Extra step |
| --- | --- | --- | --- |
| Xiaomi / Redmi / HyperOS | Settings → Apps → Harness Remote → Notifications → Allow | Battery → No restrictions | Security → Autostart → allow Harness Remote |
| Samsung / One UI | Settings → Apps → Harness Remote → Notifications → Allow | Battery → Unrestricted; remove from Sleeping apps | Turn off “Put unused apps to sleep” for this app if present |
| Google Pixel / stock Android | Settings → Apps → Harness Remote → Notifications → Allow | Battery → Unrestricted (optional, for faster delivery) | Disable Do Not Disturb for the Attention channel if needed |
| OnePlus / OPPO / ColorOS | Settings → Apps → Harness Remote → Notifications → Allow | Battery → Allow background activity | Auto-launch / allow background activity |
| Other Android | Settings → Apps → Harness Remote → Notifications | Battery → Unrestricted | Check any vendor “power saving” list |

After changing these, open Harness Remote once so it can reconcile the paired machines and restart
the service.

## Emulator functional matrix

`.github/workflows/android-emulator.yml` runs the background attention instrumentation suite on
API 34 and API 35 nightly and on manual dispatch. It covers:

- foreground service and persistent notification;
- destroyed activity and forced deep Doze;
- permission/question delivery, dedupe and exact Session deep link;
- permission Allow-once/Deny actions and exactly-once reply guard;
- Ready/Failed outcome notifications and visible-Session suppression;
- Stop action.

The matrix is a functional gate, not a battery measurement.

## Real-device battery soak

A real-device soak is still required for release evidence. Run it on the devices you actually
support; the emulator matrix cannot prove OEM power behaviour. The helper script
`scripts/android-battery-soak.sh` resets and collects the diagnostics; it waits for the soak
duration without changing app state.

### Protocol

1. Install the current debug or release APK on a charged device.
2. Pair one machine and confirm the persistent notification shows **1 machine connected**.
3. In the app, open and close one Session so the visible-Session path is exercised.
4. Reset battery history:
   `adb shell dumpsys batterystats --reset`
5. Keep Wi-Fi enabled, screen off, and the device unplugged for at least **2 hours**. Do not force
   stop the app.
6. Collect evidence:
   - `adb shell dumpsys batterystats > batterystats.txt`
   - `adb shell dumpsys deviceidle > deviceidle.txt`
   - `adb shell dumpsys notification --noredact > notifications.txt`
   - a screenshot of the persistent notification and any Attention notification.
7. In the app, tap **Stop** (or Force stop only as a last resort), then verify the persistent
   notification disappears and the service is no longer connected.
8. Repeat a 2-hour baseline with the service stopped, on the same device and network, if the battery
   percentage is close enough that the difference needs attribution.

### Acceptance

- No service crash, ANR, or lost persistent notification during the soak.
- The connected machine remains reachable after the screen has been off.
- Attention notifications still arrive; visible-Session completion suppression still works.
- Stop removes the notification and the SSE connection.
- Record device model, Android/OEM build, soak duration, start/end percentage, and any OEM setting
  applied. Attach the evidence to issue #648.

### Current evidence status

The functional suite is automated in the nightly matrix. The real-device 2-hour soak must be
recorded separately; it cannot be inferred from an emulator run. The earlier Redmi Note 13 5G
(Android 16 / HyperOS) checks verified notification permission, foreground survival and deep links,
but not a full timed battery soak.

## Limits

DSH's ACP bridge auto-allows tool permissions, so a normal DSH run does not produce a pending
permission notification or Allow/Deny action. OpenCode/legacy, or a harness that advertises and holds
permissions, is required for that path.
