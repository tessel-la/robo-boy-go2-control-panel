import type {
  RoboBoyJsonObject,
  RoboBoyPanelContext,
  RoboBoyPanelDefinition,
  RoboBoyPanelInstance,
  RoboBoyRosSubscription,
} from '@tessel-la/roboboy-panel-sdk';

export const PANEL_ID = 'la.tessel.roboboy.go2-control';
export type DriveControl = 'forward' | 'back' | 'left' | 'right' | 'turn-left' | 'turn-right';
export type Velocity = { x: number; y: number; yaw: number };
export type Odometry = Velocity & { px: number; py: number; height: number; heading: number };
export type MotionStatus = { mode: 'stand' | 'walk' | 'recover' | 'fallen'; reason: string; backend: string; policies: string[] };
export const parseMotionStatus = (message: RoboBoyJsonObject): MotionStatus | null => {
  if (typeof message.data !== 'string' || message.data.length > 4096) return null;
  try {
    const value = JSON.parse(message.data);
    if (!value || !['stand', 'walk', 'recover', 'fallen'].includes(value.mode) ||
        typeof value.reason !== 'string' || typeof value.backend !== 'string' ||
        !Array.isArray(value.policies) || !value.policies.every((mode: unknown) => typeof mode === 'string')) return null;
    return { mode: value.mode, reason: value.reason.slice(0, 256), backend: value.backend.slice(0, 64),
      policies: value.policies.filter((mode: string) => ['walk', 'stand', 'recover'].includes(mode)) };
  } catch { return null; }
};
const ZERO: Velocity = { x: 0, y: 0, yaw: 0 };
const STALE_MS = 2500;
const COMMANDS: Record<DriveControl, Velocity> = {
  forward: { x: 0.2, y: 0, yaw: 0 },
  back: { x: -0.2, y: 0, yaw: 0 },
  left: { x: 0, y: 0.15, yaw: 0 },
  right: { x: 0, y: -0.15, yaw: 0 },
  'turn-left': { x: 0, y: 0, yaw: 0.4 },
  'turn-right': { x: 0, y: 0, yaw: -0.4 },
};
export const velocityForControl = (control: DriveControl): Velocity => ({ ...COMMANDS[control] });

export const isGo2Description = (message: RoboBoyJsonObject): boolean => {
  if (typeof message.data !== 'string' || message.data.length > 250_000) return false;
  const xml = new DOMParser().parseFromString(message.data, 'application/xml');
  if (xml.querySelector('parsererror') || xml.documentElement.tagName !== 'robot' ||
      xml.documentElement.getAttribute('name') !== 'go2_description') return false;
  const joints = new Set(Array.from(xml.querySelectorAll('joint')).map(joint => joint.getAttribute('name')));
  return ['FL', 'FR', 'RL', 'RR'].every(leg =>
    ['hip', 'thigh', 'calf'].every(joint => joints.has(`${leg}_${joint}_joint`)));
};

export const parseOdometry = (message: RoboBoyJsonObject): Odometry | null => {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (message.child_frame_id !== 'base') return null;
  const pose = object(object(message.pose).pose);
  const position = object(pose.position), q = object(pose.orientation);
  const twist = object(object(message.twist).twist);
  const linear = object(twist.linear), angular = object(twist.angular);
  const values = [position.x, position.y, position.z, q.w, q.x, q.y, q.z, linear.x, linear.y, angular.z];
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  const [px, py, height, w, x, y, z, vx, vy, yaw] = values as number[];
  const norm = w*w + x*x + y*y + z*z;
  if (norm < 1e-8) return null;
  return { px, py, height, x: vx, y: vy, yaw,
    heading: Math.atan2(2*(w*z + x*y) / norm, 1 - 2*(y*y + z*z) / norm) };
};

// Screen coordinates become body-frame translation; a radial dead zone prevents drift.
export const velocityForStick = (dx: number, dy: number, radius: number): Velocity => {
  if (![dx, dy, radius].every(Number.isFinite) || radius <= 0) return { ...ZERO };
  const distance = Math.hypot(dx, dy) / radius;
  if (distance <= 0.12) return { ...ZERO };
  const scale = (Math.min(distance, 1) - 0.12) / 0.88 / distance;
  return { x: -dy / radius * scale * 0.2, y: -dx / radius * scale * 0.15, yaw: 0 };
};

const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const arrow = icon('<path d="m7 10 5-5 5 5M12 5v14"/>');
const turn = icon('<path d="M5 9h8a6 6 0 0 1 0 12M5 9l4-4M5 9l4 4"/>');
const stand = icon('<path d="M5 8h13v7H5zM5 15v5m13-5v5M18 8V5h4v5M2 5l3 3"/>');
const recover = icon('<path d="M4 10a8 8 0 1 1 0 6M4 4v6h6M9 15l3-6 3 6M10 13h4"/>');
const MARKUP = `
<style>
  .go2 { box-sizing: border-box; height: 100%; padding: 12px; overflow: auto; color: var(--text-color); background: var(--background-secondary); font: 13px/1.4 var(--font-family-ui); }
  .go2 * { box-sizing: border-box; }
  .go2 header, .go2__statusline, .go2__speedline { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .go2 header { margin-bottom: 12px; }
  .go2 h2 { margin: 0; font-size: 16px; }
  .go2 p { margin: 0; color: var(--text-secondary); font-size: 11px; }
  .go2__eyebrow { font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-secondary); }
  .go2__state { display: flex; align-items: center; gap: 6px; font-size: 11px; text-align: right; }
  .go2__state::before { content: ''; width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--text-secondary); }
  .go2__state[data-ready="true"]::before { background: var(--success-color); }
  .go2__layout { display: grid; gap: 12px; }
  .go2__visual { display: flex; align-items: center; gap: 16px; min-width: 0; padding: 8px 14px; border: 1px solid var(--card-border); border-radius: 16px; background: var(--card-bg); }
  .go2__heading { width: 100px; height: 100px; flex-shrink: 0; color: var(--primary-color); }
  .go2__heading .grid { stroke: var(--border-color); fill: none; }
  .go2__heading text { fill: var(--text-secondary); font: 9px var(--font-family-ui); }
  .go2__robot { transform-origin: 60px 60px; }
  .go2__visual[data-live="false"] .go2__heading { opacity: .35; }
  .go2__visual[data-mode="fallen"], .go2__visual[data-mode="recover"] { border-color: var(--warning-color); }
  .go2__readout { flex: 1; min-width: 0; }
  .go2__readout strong { display: block; font-size: 17px; font-weight: 600; margin: 4px 0 8px; }
  .go2__speedline { align-items: baseline; }
  .go2__speedline output { font-size: 27px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .go2__speedline small { color: var(--text-secondary); font-size: 11px; }
  .go2__speed { display: block; width: 100%; height: 5px; margin: 8px 0; border-radius: 4px; background: var(--border-color); overflow: hidden; }
  .go2__speed span { display: block; width: 0; height: 100%; background: var(--primary-color); }
  .go2__controls { min-width: 0; }
  .go2__drive { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(132px, 1fr); align-items: center; gap: 14px; }
  .go2 button { min-height: 44px; padding: 8px; border: 1px solid var(--border-color); border-radius: 12px; color: var(--text-color); background: var(--card-bg); font: 600 12px/1.3 var(--font-family-ui); cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .go2 svg { pointer-events: none; }
  .go2 button > svg { width: 24px; height: 24px; }
  .go2 button[data-drive], .go2 [data-joystick] { touch-action: none; user-select: none; -webkit-user-select: none; }
  .go2 button:hover:not(:disabled) { border-color: var(--primary-color); }
  .go2 button:focus-visible, .go2:focus-visible, .go2 summary:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
  .go2 button[data-held="true"] { color: var(--button-text-color); background: var(--primary-color); border-color: var(--primary-color); }
  .go2 button:disabled { opacity: .4; cursor: default; }
  .go2__stick { position: relative; width: 164px; height: 164px; margin: 6px auto; border: 1px solid var(--border-color); border-radius: 50%; background: radial-gradient(circle, var(--background-color) 0 30%, var(--card-bg) 31% 64%, var(--background-secondary) 65%); }
  .go2__stick::before, .go2__stick::after { content: ''; position: absolute; background: var(--border-color); pointer-events: none; }
  .go2__stick::before { width: 1px; height: 72%; top: 14%; left: 50%; }
  .go2__stick::after { height: 1px; width: 72%; left: 14%; top: 50%; }
  .go2 .go2__direction { position: absolute; z-index: 1; width: 44px; height: 44px; min-height: 44px; padding: 10px; border: 0; background: transparent; border-radius: 50%; }
  .go2 [data-drive="forward"] { left: calc(50% - 22px); top: -2px; }
  .go2 [data-drive="back"] { left: calc(50% - 22px); bottom: -2px; transform: rotate(180deg); }
  .go2 [data-drive="left"] { top: calc(50% - 22px); left: -2px; transform: rotate(-90deg); }
  .go2 [data-drive="right"] { top: calc(50% - 22px); right: -2px; transform: rotate(90deg); }
  .go2 .go2__thumb { position: absolute; z-index: 2; width: 62px; height: 62px; left: calc(50% - 31px); top: calc(50% - 31px); border-radius: 50%; padding: 12px; border-color: var(--primary-color); background: var(--background-color); color: var(--primary-color); touch-action: none; }
  .go2__thumb svg { width: 100%; height: 100%; }
  .go2__turn { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .go2__turn [data-drive] { display: flex; flex-direction: column; align-items: center; gap: 4px; min-height: 64px; }
  .go2 [data-drive="turn-right"] svg { transform: scaleX(-1); }
  .go2 [data-action="stop"] { grid-column: 1 / -1; min-height: 54px; border-color: var(--error-color); color: var(--error-color); display: flex; align-items: center; justify-content: center; gap: 8px; }
  .go2 [data-action="stop"] svg { width: 18px; height: 18px; }
  .go2__hint { text-align: center; margin-top: 3px !important; }
  .go2__motions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .go2__motions button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 52px; }
  .go2 [data-motion="recover"] { border-color: var(--primary-color); }
  .go2 [data-motion][aria-pressed="true"] { background: color-mix(in srgb, var(--primary-color) 12%, var(--card-bg)); }
  .go2 footer { margin-top: 12px; }
  .go2 [data-role="feedback"] { min-height: 1.4em; }
  .go2 [data-role="policy"] { margin-top: 3px; }
  .go2 details { margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 8px; color: var(--text-secondary); font-size: 11px; }
  .go2 summary { cursor: pointer; width: fit-content; min-height: 28px; }
  .go2 dl { display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; margin: 4px 0 8px; }
  .go2 dd { margin: 0; color: var(--text-color); font-variant-numeric: tabular-nums; }
  .go2 [data-action="retry"] { margin-top: 8px; }
  .go2[data-wide="true"] .go2__layout { grid-template-columns: minmax(160px, .8fr) minmax(304px, 1.5fr); align-items: stretch; }
  .go2[data-wide="true"] .go2__visual { flex-direction: column; justify-content: center; gap: 4px; padding: 10px 16px; }
  .go2[data-wide="true"] .go2__readout { width: 100%; flex: 0; }
  .go2[data-wide="true"] .go2__readout strong { font-size: 14px; margin: 2px 0 6px; }
  .go2[data-compact="true"] { padding: 8px; }
  .go2[data-compact="true"] header { margin-bottom: 6px; }
  .go2[data-compact="true"] .go2__heading { width: 76px; height: 76px; }
  .go2[data-compact="true"] footer { margin-top: 6px; }
  .go2[data-compact="true"] details { margin-top: 4px; padding-top: 4px; }
  @media (prefers-reduced-motion: no-preference) { .go2__robot { transition: transform .1s linear; } .go2__speed span { transition: width .1s linear; } }
</style>
<section class="go2" tabindex="0" aria-label="Go2 controls">
  <header><div><div class="go2__eyebrow">Warehouse simulation</div><h2>Unitree Go2</h2></div><span class="go2__state" data-role="state" role="status">Disconnected</span></header>
  <div class="go2__layout">
    <section class="go2__visual" data-role="visual" data-live="false" aria-label="Live Go2 motion">
      <svg class="go2__heading" viewBox="0 0 120 120" role="img" aria-label="Robot heading in the odometry frame">
        <circle class="grid" cx="60" cy="60" r="48"/><circle class="grid" cx="60" cy="60" r="34" stroke-dasharray="2 6"/>
        <path class="grid" d="M60 8v8m44 44h8M60 104v8M8 60h8"/><text x="107" y="54">x</text><text x="65" y="13">y</text>
        <g class="go2__robot" data-role="heading" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m54 27 6-6 6 6"/><rect x="49" y="35" width="22" height="43" rx="7" fill="var(--background-color)"/>
          <path d="M53 35v-6h14v6M49 44H37v13m34-13h12v13M49 67H37v14m34-14h12v14M55 43h10"/>
          <circle cx="60" cy="61" r="3" fill="currentColor"/>
        </g>
      </svg>
      <div class="go2__readout"><div class="go2__eyebrow">Actual motion</div><strong data-role="activity">Waiting for telemetry</strong>
        <div class="go2__speedline"><span><output data-role="speed">—</output> <small>m/s</small></span><small data-role="compute">—</small></div>
        <div class="go2__speed" role="meter" aria-label="Measured movement speed" aria-valuemin="0" aria-valuemax="0.35" aria-valuenow="0"><span data-role="speed-bar"></span></div>
        <p data-role="direction">Heading follows live odometry</p>
      </div>
    </section>
    <section class="go2__controls" aria-label="Movement and posture">
      <div class="go2__drive"><div><div class="go2__stick" data-joystick aria-label="Movement controls">
        <button class="go2__direction" data-drive="forward" aria-label="Walk forward">${arrow}</button>
        <button class="go2__direction" data-drive="left" aria-label="Step left">${arrow}</button>
        <button class="go2__direction" data-drive="right" aria-label="Step right">${arrow}</button>
        <button class="go2__direction" data-drive="back" aria-label="Walk backward">${arrow}</button>
        <button class="go2__thumb" data-stick aria-label="Drag to move; use W S to walk and Q E to move sideways" aria-describedby="go2-drive-hint">${icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>')}</button>
      </div><p class="go2__hint" id="go2-drive-hint">Drag to move · release to stand</p></div>
      <div><div class="go2__turn">
        <button data-drive="turn-left" aria-label="Turn left">${turn}<span>Turn left</span></button>
        <button data-drive="turn-right" aria-label="Turn right">${turn}<span>Turn right</span></button>
        <button data-action="stop" aria-label="Stop motion">${icon('<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" stroke="none"/>')}<span>Stop</span></button>
      </div><p class="go2__hint">Hold to turn</p></div></div>
      <div class="go2__motions"><button data-motion="stand">${stand}<span>Stand</span></button><button data-motion="recover">${recover}<span>Stand up</span></button></div>
    </section>
  </div>
  <footer><p data-role="feedback" role="status">Connect to the Go2 ROS stack.</p><p data-role="policy">Waiting for motion status.</p><button data-action="retry" hidden>Retry telemetry</button>
    <details><summary>Details & keyboard</summary><dl>
      <dt>Forward / sideways</dt><dd data-value="velocity">—</dd><dt>Turn rate</dt><dd data-value="yaw">—</dd>
      <dt>Position x / y</dt><dd data-value="position">—</dd><dt>Heading</dt><dd data-value="heading">—</dd><dt>Body height</dt><dd data-value="height">—</dd><dt>Compute backend</dt><dd data-value="backend">—</dd>
    </dl><p>W/S walk · A/D turn · Q/E sideways · arrows walk/turn. Escape stops. Focus this tile to use keys.</p><p>Ideal simulator odometry. Cancel navigation before manual control. Stop sends zero velocity; it does not cancel navigation.</p></details>
  </footer>
</section>`;

type HeldInput = { velocity: Velocity; control?: DriveControl; target?: HTMLElement; pointerId?: number; stick?: { cx: number; cy: number; radius: number } };
const createPanel = (context: RoboBoyPanelContext): RoboBoyPanelInstance => {
  let root: HTMLElement | null = null;
  let mountedContainer: HTMLElement | null = null;
  let connection = context.connection.getSnapshot();
  let viewport = context.viewport.getSnapshot();
  let requestedActive = true;
  let recognized = false;
  let odometry: Odometry | null = null;
  let receivedAt = -Infinity;
  let motion: MotionStatus | null = null;
  let statusAt = -Infinity;
  let session = 0;
  let started = false;
  let failed = false;
  let subscriptions: RoboBoyRosSubscription[] = [];
  const listeners: (() => void)[] = [];
  const held = new Map<string, HeldInput>();
  let monitor: ReturnType<typeof setInterval> | null = null;
  let driveTimer: ReturnType<typeof setInterval> | null = null;
  let commandEpoch = 0;
  let pendingCommand = false;
  let wasReady = false;

  const active = () => Boolean(root) && requestedActive && viewport.isActive;
  const connected = () => Boolean(context.ros) && connection.status === 'connected';
  const live = () => Boolean(odometry) && Date.now() - receivedAt < STALE_MS;
  const motionAvailable = () => active() && connected() && recognized && live() && motion !== null && Date.now() - statusAt < STALE_MS && !failed;
  const ready = () => motionAvailable() && (motion?.mode === 'walk' || motion?.mode === 'stand');
  const feedback = (text: string) => {
    const element = root?.querySelector('[data-role="feedback"]');
    if (element) element.textContent = text;
  };
  const publish = (velocity: Velocity) => context.ros!.publish({
    topic: '/cmd_vel', messageType: 'geometry_msgs/msg/Twist',
    message: { linear: { x: velocity.x, y: velocity.y, z: 0 }, angular: { x: 0, y: 0, z: velocity.yaw } },
  });
  const command = (): Velocity => {
    const value = [...held.values()].reduce((sum, item) => ({ x: sum.x + item.velocity.x, y: sum.y + item.velocity.y, yaw: sum.yaw + item.velocity.yaw }), { ...ZERO });
    // Bound combined fingers/keys to the same envelope as an individual control.
    const translation = Math.max(1, Math.hypot(value.x / .2, value.y / .15));
    return { x: value.x / translation, y: value.y / translation, yaw: Math.max(-.4, Math.min(.4, value.yaw)) };
  };
  const render = () => {
    if (!root) return;
    const available = ready();
    const state = root.querySelector<HTMLElement>('[data-role="state"]')!;
    state.textContent = !context.ros ? 'ROS unavailable' : !active() ? 'Paused' : !connected() ? 'Disconnected' : failed ? 'Telemetry unavailable' : !recognized ? 'Waiting for Go2' : !live() ? (odometry ? 'Odometry stale' : 'Waiting for odometry') : !motionAvailable() ? 'Waiting for motion status' : motion?.mode === 'recover' ? 'Recovering' : motion?.mode === 'fallen' ? 'Fallen · stand up available' : 'Ready';
    state.dataset.ready = String(available);
    root.dataset.wide = String(viewport.width >= 580);
    root.dataset.compact = String(viewport.height < 380);
    root.querySelectorAll<HTMLButtonElement>('[data-drive], [data-stick], [data-action="stop"]').forEach(button => {
      button.disabled = !available;
      button.dataset.held = String([...held.values()].some(item => button.hasAttribute('data-stick') ? Boolean(item.stick) : item.control === button.dataset.drive));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-motion]').forEach(button => {
      button.disabled = !motionAvailable() || !motion?.policies.includes(button.dataset.motion!) || motion?.mode === 'recover' || (button.dataset.motion === 'stand' && motion?.mode === 'fallen');
      button.setAttribute('aria-pressed', String(motionAvailable() && motion?.mode === button.dataset.motion));
    });
    const stick = [...held.values()].find(item => item.stick);
    root.querySelector<HTMLElement>('[data-stick]')!.style.transform = stick ? `translate(${-stick.velocity.y / .15 * 42}px, ${-stick.velocity.x / .2 * 42}px)` : '';
    root.querySelector<HTMLElement>('[data-role="policy"]')!.textContent = motionAvailable() ? motion!.reason : 'Waiting for motion status.';
    const retry = root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    retry.hidden = !failed;
    retry.disabled = !active() || !connected();
    if (!available && !failed) feedback(!active() ? 'Controls paused.' : !connected() ? 'Connect to the Go2 ROS stack.' : !motionAvailable() ? 'Waiting for fresh Go2 telemetry.' : motion?.mode === 'recover' ? 'Getting up. Walking unlocks after a stable stance.' : 'Use Stand up to request recovery.');
    else if (available && !wasReady) feedback('Hold a direction or drag the stick to move.');
    wasReady = available;
    const measured = motionAvailable() ? odometry : null;
    const speed = measured ? Math.hypot(measured.x, measured.y) : 0;
    const visual = root.querySelector<HTMLElement>('[data-role="visual"]')!;
    visual.dataset.live = String(Boolean(measured));
    visual.dataset.mode = measured ? motion!.mode : '';
    root.querySelector<HTMLElement>('[data-role="activity"]')!.textContent = !measured ? 'Waiting for telemetry' : motion!.mode === 'recover' ? 'Getting up' : motion!.mode === 'fallen' ? 'Needs recovery' : speed > .025 ? 'Moving' : Math.abs(measured.yaw) > .08 ? 'Turning' : 'Standing';
    root.querySelector<HTMLElement>('[data-role="speed"]')!.textContent = measured ? speed.toFixed(2) : '—';
    const meter = root.querySelector<HTMLElement>('[role="meter"]')!;
    meter.setAttribute('aria-valuenow', String(Math.min(.35, speed)));
    meter.setAttribute('aria-valuetext', measured ? `${speed.toFixed(2)} meters per second` : 'Telemetry unavailable');
    root.querySelector<HTMLElement>('[data-role="speed-bar"]')!.style.width = `${Math.min(1, speed / .35) * 100}%`;
    root.querySelector<SVGElement>('[data-role="heading"]')!.style.transform = measured ? `rotate(${90 - measured.heading * 180 / Math.PI}deg)` : '';
    root.querySelector<HTMLElement>('[data-role="direction"]')!.textContent = measured ? `${Math.round(measured.heading * 180 / Math.PI)}° · odometry heading` : 'Heading follows live odometry';
    root.querySelector<HTMLElement>('[data-role="compute"]')!.textContent = !measured ? '—' : motion!.backend.startsWith('cuda') ? 'GPU · CUDA' : motion!.backend.startsWith('cpu') ? 'CPU' : 'GPU';
    const values: Record<string, string> = measured ? {
      velocity: `${measured.x.toFixed(2)} / ${measured.y.toFixed(2)} m/s`, yaw: `${measured.yaw.toFixed(2)} rad/s`,
      position: `${measured.px.toFixed(2)} / ${measured.py.toFixed(2)} m`,
      heading: `${measured.heading.toFixed(2)} rad`, height: `${measured.height.toFixed(2)} m`, backend: motion!.backend,
    } : {};
    root.querySelectorAll<HTMLElement>('[data-value]').forEach(element => { element.textContent = values[element.dataset.value!] ?? '—'; });
  };
  const stop = (force = false) => {
    const wasHeld = held.size > 0;
    if (driveTimer !== null) clearInterval(driveTimer);
    driveTimer = null;
    const previous = [...held.values()];
    held.clear();
    commandEpoch++;
    pendingCommand = false;
    previous.forEach(item => { if (item.pointerId !== undefined && item.target?.hasPointerCapture?.(item.pointerId)) item.target.releasePointerCapture(item.pointerId); });
    if ((wasHeld || force) && connected()) {
      void publish(ZERO).catch(error => context.logger.warn('Go2 stop failed; the simulator command expires after 0.5 s.', error));
    }
    render();
  };
  const tick = () => {
    if (!ready()) { stop(); return; }
    if (pendingCommand) return;
    const epoch = commandEpoch;
    pendingCommand = true;
    void publish(command()).catch(error => {
      if (commandEpoch !== epoch) return;
      stop();
      feedback(`Motion stopped: ${String(error)}. Release the control and try again.`);
    }).finally(() => { if (commandEpoch === epoch) pendingCommand = false; });
  };
  const start = (owner: string, value: HeldInput) => {
    if (!ready() || held.has(owner)) return;
    held.set(owner, value);
    if (driveTimer === null) { commandEpoch++; driveTimer = setInterval(tick, 50); }
    tick();
    feedback('Release to stand. You can move and turn together.');
    render();
  };
  const release = (owner: string) => {
    if (!held.delete(owner)) return;
    if (held.size === 0) { stop(true); if (ready()) feedback('Released. Hold or drag to move again.'); }
    else { tick(); render(); }
  };
  const unsubscribe = (subscription: RoboBoyRosSubscription) => {
    void subscription.unsubscribe().catch(error => context.logger.warn('Go2 telemetry cleanup failed.', error));
  };
  const suspend = () => {
    stop();
    session++;
    started = false;
    if (monitor !== null) clearInterval(monitor);
    monitor = null;
    subscriptions.forEach(unsubscribe);
    subscriptions = [];
    recognized = false;
    odometry = null;
    receivedAt = -Infinity;
    motion = null;
    statusAt = -Infinity;
  };
  const reconcile = () => {
    if (!active() || !connected()) { suspend(); render(); return; }
    if (started || failed) { render(); return; }
    started = true;
    failed = false;
    const current = ++session;
    const subscribe = (topic: string, messageType: string, receive: (message: RoboBoyJsonObject) => void) => {
      void context.ros!.subscribe({ topic, messageType, throttleMs: 100, queueLength: 1 }, message => {
        if (session !== current || !active() || !connected()) return;
        receive(message);
        if (!ready()) stop();
        render();
      }).then(subscription => {
        if (session !== current || !active() || !connected()) unsubscribe(subscription);
        else subscriptions.push(subscription);
      }, error => {
        if (session !== current) return;
        suspend(); failed = true;
        feedback(`Telemetry failed: ${String(error)}. Retry to reconnect.`); render();
      });
    };
    subscribe('/robot_description', 'std_msgs/msg/String', message => { recognized = isGo2Description(message); });
    subscribe('/go2/status', 'std_msgs/msg/String', message => { motion = parseMotionStatus(message); statusAt = motion ? Date.now() : -Infinity; });
    subscribe('/odom', 'nav_msgs/msg/Odometry', message => { odometry = parseOdometry(message); receivedAt = odometry ? Date.now() : -Infinity; });
    monitor = setInterval(() => { if (!ready()) stop(); render(); }, 250);
    feedback('Hold a direction or drag the stick when Go2 is ready.'); render();
  };
  const keyControl: Record<string, DriveControl> = {
    w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back',
    a: 'turn-left', ArrowLeft: 'turn-left', d: 'turn-right', ArrowRight: 'turn-right', q: 'left', e: 'right',
  };
  const key = (event: KeyboardEvent) => event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    const next = (event.key === 'Enter' || event.key === ' ') && button?.dataset.drive ? button.dataset.drive as DriveControl : keyControl[key(event)];
    if (next) { event.preventDefault(); if (!event.repeat) start(`key:${key(event)}`, { velocity: velocityForControl(next), control: next }); }
    else if (event.key === 'Escape' || (event.key === ' ' && !button)) { event.preventDefault(); stop(true); }
  };
  const onKeyUp = (event: KeyboardEvent) => { if (held.has(`key:${key(event)}`)) { event.preventDefault(); release(`key:${key(event)}`); } };
  const onPointerDown = (event: PointerEvent) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-drive], [data-stick]');
    if (!button || button.disabled || event.button !== 0 || !ready()) return;
    if (button.hasAttribute('data-stick') && [...held.values()].some(item => item.stick)) return;
    event.preventDefault(); button.focus();
    button.setPointerCapture?.(event.pointerId);
    const value: HeldInput = { velocity: { ...ZERO }, target: button, pointerId: event.pointerId };
    if (button.dataset.drive) { value.control = button.dataset.drive as DriveControl; value.velocity = velocityForControl(value.control); }
    else {
      const rect = root!.querySelector<HTMLElement>('[data-joystick]')!.getBoundingClientRect();
      value.stick = { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, radius: rect.width / 2 - 31 };
      value.velocity = velocityForStick(event.clientX - value.stick.cx, event.clientY - value.stick.cy, value.stick.radius);
    }
    start(`pointer:${event.pointerId}`, value);
  };
  const onPointerMove = (event: PointerEvent) => {
    const value = held.get(`pointer:${event.pointerId}`);
    if (!value?.stick) return;
    if (!ready()) { stop(); return; }
    event.preventDefault();
    value.velocity = velocityForStick(event.clientX - value.stick.cx, event.clientY - value.stick.cy, value.stick.radius);
    tick(); render();
  };
  const onPointerUp = (event: PointerEvent) => release(`pointer:${event.pointerId}`);
  const onBlur = () => stop();
  const onFocusOut = (event: FocusEvent) => { if (!root?.contains(event.relatedTarget as Node | null)) stop(); };
  const onClick = (event: MouseEvent) => {
    const action = (event.target as Element).closest<HTMLButtonElement>('[data-action], [data-motion]');
    if (!action || action.disabled) return;
    if (action.dataset.motion) {
      stop();
      const current = session;
      void context.ros!.publish({topic: '/go2/motion_cmd', messageType: 'std_msgs/msg/String', message: {data: action.dataset.motion}}).then(() => { if (session === current) feedback('Motion requested. Watch the live state for completion.'); }, error => { if (session === current) feedback(`Motion request failed: ${String(error)}`); });
    }
    else if (action.dataset.action === 'stop') { stop(true); feedback('Stop sent. Release all controls before moving again.'); }
    else { suspend(); failed = false; reconcile(); }
  };
  return {
    mount(container) {
      mountedContainer = container;
      container.innerHTML = MARKUP;
      root = container.querySelector<HTMLElement>('.go2')!;
      root.addEventListener('pointerdown', onPointerDown);
      root.addEventListener('lostpointercapture', onPointerUp);
      root.addEventListener('keydown', onKeyDown);
      root.addEventListener('keyup', onKeyUp);
      root.addEventListener('focusout', onFocusOut);
      root.addEventListener('click', onClick);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', onBlur);
      listeners.push(context.connection.subscribe(snapshot => {
        const changed = snapshot.generation !== connection.generation || snapshot.status !== connection.status;
        if (changed) { suspend(); failed = false; }
        connection = snapshot; reconcile();
      }));
      listeners.push(context.viewport.subscribe(snapshot => {
        if (snapshot.width !== viewport.width || snapshot.height !== viewport.height) stop();
        viewport = snapshot; reconcile();
      }));
      reconcile();
    },
    setActive(value) { requestedActive = value; reconcile(); },
    unmount() {
      suspend(); listeners.splice(0).forEach(remove => remove());
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onBlur);
      mountedContainer?.replaceChildren(); mountedContainer = null; root = null;
    },
  };
};

const definition: RoboBoyPanelDefinition = { apiVersion: '2.0.0', id: PANEL_ID, activate: createPanel };
export default definition;
