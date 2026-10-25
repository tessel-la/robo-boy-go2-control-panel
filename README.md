# Go2 Control for Robo-Boy

Walk the existing Unitree Go2 simulation from a Robo-Boy workspace tile. Hold a direction
to move; release it to stand and balance. Live readouts show body velocity, position,
heading, and height from the simulator's ideal odometry. **Stand** and **Recover / stand up**
use the existing FR-Net recovery checkpoint; the panel reports the active motion
and compute backend.

This is an external Panel API v2 panel in its own repository. It uses the published
walking policy already running in [`genesis-mobile-sim`](https://github.com/tessel-la/genesis-mobile-sim).
It does not create a robot, train a gait, or implement robot services.

## Build

Use Node.js 22 or later. Clone [Robo-Boy](https://github.com/tessel-la/robo-boy)
alongside this repository, so `../robo-boy/panel-sdk` exists before installing.
The checkout uses that type-only SDK 2.2.0. Runtime dependencies are not required.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run integrity
npm run validate
```

`integrity` updates the SHA-256 SRI in `roboboy.panel.json`. Rebuild and update it after
changing source. `validate` imports the built artifact and checks its identity and digest.

## Install locally

The current deployment's panel manager mounts the sibling workspace at `/panel-workspace`.
Add `robo-boy-go2-control-panel` to its existing local source and preview/apply with
**Manage installations…**. Preserve the existing selection and other panel repositories.
The manager verifies and atomically installs the artifact without restarting Robo-Boy.
A minimal source configuration is in [examples/panel-sources.json](examples/panel-sources.json).
For other deployments, mount this repository into their manager workspace first; see
[Robo-Boy's custom-panel guide](https://github.com/tessel-la/robo-boy/blob/main/docs/custom-panels.md).

Refresh Robo-Boy, connect to the Go2 ROS stack, then choose **Add workspace panel →
Go2 Control**. Request control from Robo-Boy's control menu before driving. Only one
simulator should publish the standard robot topics in that ROS domain.

## Controls

- Hold the forward/backward buttons or W/S: ±0.2 m/s
- Hold the sideways buttons or Q/E: ±0.15 m/s
- Hold the turn buttons or A/D: ±0.4 rad/s
- **Stand** ends walking and selects the recovery policy's standing behavior
- **Recover / stand up** runs the published recovery policy and waits for a stable stance
- Arrow keys walk forward/backward and turn; Space stops when the tile itself has focus
- Enter or Space holds a focused direction button; release the key to stop

Focus the tile before using keys. Commands repeat at 20 Hz while held. Release,
pointer cancellation, focus loss, hidden tiles, disconnected ROS, changed connections,
stale odometry, and removal end the repeating command. The simulator also expires
commands after 0.5 s of wall time. Reconnection never resumes a held direction.

Controls become available only after `/robot_description` identifies the Go2 model
and fresh `/odom` data uses the `base` frame. Fresh `/go2/status` data must confirm
that walking is available. During recovery or a fall, walking is disabled; an explicit
recovery request remains available when the robot is fallen. Failed subscriptions expose **Retry telemetry**.
Hidden tiles release subscriptions and timers. The layout follows the host viewport
and theme, including narrow tiles.

## Permissions

The only capability is `ros`:

| Access | Exact topic | Purpose |
| --- | --- | --- |
| Subscribe | `/robot_description` | Identify the existing Go2 before enabling motion |
| Subscribe | `/odom` | Read live pose/velocity and detect stale telemetry |
| Subscribe | `/go2/status` | Read execution state, available motions, and compute backend |
| Publish | `/go2/motion_cmd` | Request standing or learned recovery |
| Publish | `/cmd_vel` | Send bounded walking/turning commands and stop |

The panel requests no discovery, services, storage, network, or device access.

## Limits

Cancel navigation before manual control. **Stop** sends zero velocity; it does not cancel
Nav2 goals or act as a hardware emergency stop. The two reused policies provide walking, standing, and recovery. Sit, jump, and
hardware control are outside this panel's contract. Recovery can fail near obstacles;
the simulator applies a 12 s simulated timeout and leaves the robot in damping.
Use Robo-Boy's existing Camera and 3D view panels for images and lidar. Navigation
actions stay in Robo-Boy's native action/behavior-tree tools because Panel API v2 has no actions.

This is a local, unpublished panel. No remote catalog or release is required to install it here.

## Verification

The 13 automated checks cover model/odometry validation, held commands and release,
keyboard and pointer cancellation, stale telemetry, connection changes, inactive tiles,
failed subscriptions and retry, publish failures, late subscription cleanup, and
recovery state acknowledgement before allowing walking.
The installed sandbox was checked in the running Robo-Boy for add, reload, reconnect,
live telemetry, and a ROS-observed command followed by zero on release. Dark, light,
Solarized, and custom theme tokens were checked in an isolated preview at narrow and
wide tile widths. Backward and both sideways commands were also verified with the
existing Go2 model and policy in a separate CPU simulation.
