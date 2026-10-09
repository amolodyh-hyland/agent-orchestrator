Agent Orchestrator — custom internal build

Drag Agent Orchestrator.app onto the Applications shortcut.

Start installation from your own Finder or Terminal, outside Agent Orchestrator.
Quit AO yourself first; quitting ends its active sessions. Use the PKG or the
install script when you want AO's database, settings, and prior app backed up.

This app uses an ad-hoc signature and has no Apple certificate or notarization.
If Gatekeeper blocks the first open, use Finder's Open action on the app, then
choose Open Anyway in Privacy & Security if macOS asks. The installer clears
quarantine. If macOS says the app is damaged, run this in Terminal:

  xattr -dr com.apple.quarantine "/Applications/Agent Orchestrator.app"

For the Agent Orchestrator Safe Storage Keychain prompt, choose Always Allow
and enter your login password. macOS may ask for folder access again because
permissions were granted to the previous app signature.

Updates are disabled in this build. Rebuild and reinstall to update it.
