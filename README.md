# HOTAS Uplink by DeltaWerks

Configure your flight controls in 3D and apply your bindings to Star Citizen. HOTAS Uplink reads your active game profile, shows each assignment on the physical control, and lets you save, apply and restore layouts.

**[Download the Windows app (.zip) · v0.5.2](https://github.com/Deltawerks/HOTASUplink/releases/download/v0.5.2/HOTAS-Uplink-0.5.2-win32-x64.zip)**

Extract the ZIP and open **HOTAS Uplink.exe**. GitHub’s green **Code → Download ZIP** gives you the source code if you want to inspect or build it yourself.

This guide covers the **VKB Gladiator EVO right stick and left Omni-Throttle** with optional **GNX SEM**, and the **VIRPIL VPC Constellation ALPHA Prime pair** on MT-50CM3 bases with optional **R1-FALCON pedals**. The Windows ZIP for this build includes all six finished models and a HOTAS Uplink starter layout for each stick pair. The screenshot shows the VKB setup with example bindings.

![Desk view showing an example two-stick layout, the SEM module, and labels attached to their controls](docs/desk-view.png)

## Open the viewer

Extract the Windows ZIP and open **HOTAS Uplink.exe** inside the extracted folder. Keep the executable with its neighboring files. You can browse saved bindings with the controllers unplugged.

For mouse-only editing with software graphics, open **HOTAS Uplink - Compatibility.cmd** in the same folder. This mode skips the Windows joystick reader. You can select controls, search actions and save layouts. Close the app before switching launch modes. From source, use `npm start -- --compatibility-mode`.

On first launch, choose your stick pair. **Automatic for these controllers** reads your active Star Citizen profile, including inherited joystick assignments. If it finds bindings it can label on the selected sticks, you see your own setup. Otherwise it chooses a starting layout for the pair.

| Selected sticks | Starting layout when your active profile has no mapped controls on those sticks |
| --- | --- |
| VKB Gladiator EVO / Omni-Throttle | The installed **VKB Gladiator NXT Premium Dual** game preset. If unavailable, the viewer uses the bundled VKB starter. |
| VIRPIL ALPHA Prime | The bundled VIRPIL starter. Star Citizen LIVE build 4.10.201.48085 has no factory layout for this pair. |

The top bar identifies the layout you are viewing. HOTAS Uplink starters are example flight bindings created by DeltaWerks. You can explore both pairs before you plug in a controller or install the game. To see your own bindings for a nonstandard installation, click **Choose LIVE folder…** and select the folder containing `Data.p4k`.

Click the layout name in the top bar to choose **Active game profile**, **New blank layout**, a saved XML, a game preset, or a HOTAS Uplink starter. Choosing **Active game profile** explicitly shows what Star Citizen saved, even for a pair without assignments. Each controller setup remembers your choice. Select **Automatic for these controllers** to return to automatic selection. Opening a layout only previews its bindings.

- Switch setups with **Controllers** in the top bar. In **Desk view**, **Left** and **Right** focus the view on one stick.
- The VIRPIL button numbers follow the left and right **VPC ALPHA Prime** grip diagrams. A custom firmware configuration can report different numbers. Use **Input monitor** to check them.
- The VIRPIL starter shows the **R1-FALCON pedals** on first view. Sliding the pedals controls ship **Roll**. For ground vehicles, the starter suggests **Drive backward** on the left footplate and **Drive forward** on the right. Connect the pedals and identify each footplate under **Settings → Toe brake axes** to include its binding when you save. You can switch the pedals **Off** for a sticks-only starter. Uplink remembers your choice.
- The viewer opens in **Quick view** on first launch. Each short action label stays pinned beside its control as you rotate the model. Click a label to see its directions, gestures and game contexts. Choose **Edit** beside an input to change it.
- Point at a control and scroll to zoom there. Hat switches show their hardware names in the desk overview. As you zoom in, the visible five-way hats unfold together. Zoom closer for the eight-way POV hats. On either VIRPIL grip, the ministick, side rocker, thumb hat, and scroll wheel also show each input, including unassigned ones. Click an input to inspect or edit its binding, or zoom out to fold the groups.
- Use the **Quick view** switch to change views. The app remembers your choice the next time it opens. With Quick view off, press or select a control in **All** to see its assignments. **Locate on controller** turns the camera to the selected control.
- **Reference sheet** gives the annotated controller models the full window. Rotate the models or scroll either column of labels. **Flying first** puts cockpit actions at the top of shared controls. **All contexts** uses the profile order. You can open the sheet during an edit and choose **Back to editing** to resume your draft.
- Search for an action, a control name, or a button number. **Binding sheet** shows every assignment, including actions that share a button across game contexts.
- Open **Settings** at the bottom right and drag **Text size** to resize the interface and Quick view labels. The camera holds its position. The app remembers one percentage across displays.
- **SEM module** starts **Off**. Choose **Outside left** or **Outside right** to add the GNX-SEM beside a stick. The app remembers that placement. Choose each lever's detents in **Settings → SEM lever positions**.
- Turning a center base wheel selects its throttle control. If your stick reports that wheel on a different axis, open **Settings**, choose **Identify wheel** for that stick, and roll it. The app remembers the reported axis for that side.
- Open **Input monitor** to compare the devices Star Citizen saved with the devices Windows sees. Its four-position dial check records the logical button reported when you press B1 in each position.

## Edit and save a layout

1. Choose **Edit layout**. With **Control first**, click a control on the model, choose a hat direction, or press a physical button, then search for the action. With **Action first**, search for an action such as “missile,” select it, then click or press the control you want.
2. In **Control first**, the selected button shows its current assignments and gestures. To clear just one, click **Remove** beside that row. If a layout has no saved joystick slots, choose the appropriate slot for that stick before assigning a new command.
3. Select the new action and review its gesture. On an occupied button, **Replace assignment** lists the commands it will clear from that button, including other gestures and game contexts. Other buttons assigned to the chosen action keep working. **Undo last** reverses a removal or replacement in one click.
4. Choose **Save layout for Star Citizen…**. When editing a saved layout, its name is already filled in. Choose **Save changes** to update that file, or enter a new name to save a copy. If you choose a different existing layout, review its name and confirm the replacement. You can also give a game preset or an Uplink starter a name and save a copy without editing it. The named XML goes in `USER/Client/0/Controls/Mappings` under the selected game installation. To use it in the game, follow the next step below.

## Apply a preset and switch back

With Star Citizen closed, open the layout picker and select a **Saved layout** or **Game preset**. Desk view previews its bindings. Choose **Apply for next launch**, then **Apply preset**. Once you see **Ready for next launch**, start the game normally. You can also apply a layout you just saved.

Apply matches the selected setup's controllers to the active game profile, including when their joystick slot numbers differ. It replaces bindings for the represented sticks. With **R1-FALCON pedals** on, a layout containing pedal assignments also replaces the pedal bindings. Switch the pedals off to keep their current assignments. Apply preserves the active keyboard, mouse, unrelated controllers and joystick calibration. If a device cannot be identified, the app explains which match it needs.

Before each change, HOTAS Uplink saves a dated copy of the entire active `actionmaps.xml` in `USER/Client/0/Profiles/default/HOTAS-Uplink-backups` under the selected installation. To switch back, close the game, open the layout picker, and choose **Restore previous bindings…** under **Binding backup**. Choose the backup you want and confirm. Restoring brings back all control settings in that snapshot, including keyboard or mouse settings you may have changed since.

While the game is running, you can still save a named layout and import it under Star Citizen's **Options → Keybindings → Joystick / HOTAS → Advanced Controls Customization → Control Profiles**. After the game saves its settings, **Check active bindings** compares your named layout with the active bindings on disk. [RSI profile import guide](https://support.robertsspaceindustries.com/hc/en-us/articles/360000183328-Create-export-and-import-custom-profiles)

## Run from source

For an input audit, start with the Windows reader. It opens supported game controllers through DirectInput and reports button, hat and axis events to the app. Compatibility mode skips this reader. The game profile reader and backup writer show which local Star Citizen files the app reads or changes. [Controller reader](src/input/VkbReader.cs) · [Game profile reader](src/game/profile.cjs) · [Backup and restore](src/game/active-files.cjs)

Use 64-bit Windows and Node.js 24 with npm. From the project directory, run

```powershell
npm ci
npm start
```

The Windows build uses the .NET Framework 4.x C# compiler and the Windows `tar.exe` utility. The Windows ZIP includes the finished controller models in `resources/app/assets/rig/` with their textures embedded. Raw capture photos, working scans, personal bindings and backups stay out of the release.

| Command | Result |
| --- | --- |
| `npm test` | Runs the profile, backup/restore, input and UI logic tests using disposable data. |
| `npm run build` | Packages the local Windows app and prints its path. |
| `npm run build -- --public` | Creates a portable Windows ZIP in `dist/` with the registered controller models and third-party notices. |

For a hardware mapping report, include the game build, controller and base, which hand and control you moved, and what **Input monitor** displayed. For a SEM report, also include which stick hosts it.

To propose a new controller setup, include the exact model names, photos from several angles of each controller, and a named Star Citizen layout exported for those devices. An owner can then verify that each physical button, hat and axis matches its on-screen label.

## License

HOTAS Uplink is source-available under the PolyForm Strict License 1.0.0. You can inspect the code before installing, build an unmodified copy yourself, and use the app for personal, noncommercial flying. Modifying or redistributing DeltaWerks’ code, app or finished controller models requires separate permission from DeltaWerks, even if you give your copy away for free. To share HOTAS Uplink with a friend, send them the official download link. [Download HOTAS Uplink](https://github.com/Deltawerks/HOTASUplink/releases/latest) · [Full project license](LICENSE)

Copyright 2026 DeltaWerks. Third-party components have their own licenses. [Third-party notices](ASSET-NOTICES.md)

