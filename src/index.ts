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

const MARKUP = `
<style>
  .go2 { box-sizing: border-box; height: 100%; padding: 14px; overflow: auto; color: var(--text-color); background: var(--background-secondary); font: 14px/1.4 var(--font-family-ui); }
  .go2 * { box-sizing: border-box; }
  .go2 header { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  .go2 h2 { margin: 0; font-size: 18px; }
  .go2 p { margin: 6px 0 0; color: var(--text-secondary); font-size: 12px; }
  .go2__state { padding: 5px 9px; border-radius: 20px; border: 1px solid var(--border-color); font-size: 12px; }
  .go2__state[data-ready="true"] { color: var(--success-color); border-color: var(--success-color); }
  .go2__layout { display: grid; grid-template-columns: 1fr; gap: 12px; }
  .go2[data-wide="true"] .go2__layout { grid-template-columns: minmax(230px, 1fr) minmax(210px, 1fr); }
  .go2__card { min-width: 0; padding: 12px; border: 1px solid var(--card-border); border-radius: 12px; background: var(--card-bg); }
  .go2 h3 { margin: 0 0 12px; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
  .go2__drive { display: grid; grid-template-columns: repeat(3, minmax(56px, 1fr)); gap: 8px; }
  .go2 button { min-height: 48px; padding: 8px; border: 1px solid var(--border-color); border-radius: 9px; color: var(--text-color); background: var(--background-color); font: 600 13px/1.2 var(--font-family-ui); cursor: pointer; }
  .go2 button[data-drive] { touch-action: none; user-select: none; -webkit-user-select: none; }
  .go2 button:hover:not(:disabled) { border-color: var(--primary-color); }
  .go2 button:focus-visible, .go2:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .go2 button[data-held="true"] { color: var(--button-text-color); background: var(--primary-color); border-color: var(--primary-color); }
  .go2 button:disabled { opacity: .45; cursor: default; }
  .go2 [data-action="stop"] { border-color: var(--error-color); color: var(--error-color); }
  .go2 [data-drive="forward"] { grid-area: 1 / 2; }
  .go2 [data-drive="left"] { grid-area: 2 / 1; }
  .go2 [data-action="stop"] { grid-area: 2 / 2; }
  .go2 [data-drive="right"] { grid-area: 2 / 3; }
  .go2 [data-drive="back"] { grid-area: 3 / 2; }
  .go2 [data-drive="turn-left"] { grid-area: 3 / 1; }
  .go2 [data-drive="turn-right"] { grid-area: 3 / 3; }
  .go2 dl { display: grid; grid-template-columns: 1fr auto; gap: 9px 12px; margin: 0; font-size: 13px; }
  .go2 dt { color: var(--text-secondary); }
  .go2 dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .go2__motions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .go2__motions button { flex: 1 1 100px; }
  .go2 footer { margin-top: 12px; }
  .go2 [data-role="feedback"] { min-height: 2.8em; }
  .go2 [data-action="retry"] { margin-top: 8px; min-height: 36px; }
</style>
<section class="go2" tabindex="0" aria-label="Go2 controls">
  <header><div><h2>Go2 Control</h2><p>Unitree Go2 · Warehouse</p></div><span class="go2__state" data-role="state" role="status">Disconnected</span></header>
  <div class="go2__layout">
    <section class="go2__card"><h3>Hold to walk</h3><div class="go2__drive">
      <button data-drive="forward" aria-label="Walk forward">↑<br>Forward</button>
      <button data-drive="left" aria-label="Step left">←<br>Sideways</button><button data-action="stop" aria-label="Stop motion">Stop</button><button data-drive="right" aria-label="Step right">→<br>Sideways</button>
      <button data-drive="back" aria-label="Walk backward">↓<br>Backward</button>
      <button data-drive="turn-left" aria-label="Turn left">↶<br>Turn left</button><button data-drive="turn-right" aria-label="Turn right">↷<br>Turn right</button>
    </div><p>Release to stand and balance.</p><div class="go2__motions"><button data-motion="stand">Stand</button><button data-motion="recover">Recover / stand up</button></div><p data-role="policy" role="status">Waiting for motion status.</p></section>
    <section class="go2__card"><h3>Live telemetry</h3><dl>
      <dt>Forward velocity</dt><dd data-value="x">—</dd><dt>Sideways velocity</dt><dd data-value="y">—</dd><dt>Turn rate</dt><dd data-value="yaw">—</dd>
      <dt>Position x / y</dt><dd data-value="position">—</dd><dt>Heading</dt><dd data-value="heading">—</dd><dt>Body height</dt><dd data-value="height">—</dd><dt>Compute backend</dt><dd data-value="backend">—</dd>
    </dl><p>Ideal simulator odometry · /odom</p></section>
  </div>
  <footer><p data-role="feedback" role="status">Connect to the Go2 ROS stack.</p><button data-action="retry" hidden>Retry telemetry</button><p>W/S walk · A/D turn · Q/E sideways · Space stops.<br>Focus this tile to use keys. Cancel navigation before manual control.</p></footer>
</section>`;

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
  let monitor: ReturnType<typeof setInterval> | null = null;
  let driveTimer: ReturnType<typeof setInterval> | null = null;
  let control: DriveControl | null = null;
  let input: string | null = null;
  let commandEpoch = 0;
  let pendingCommand = false;

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
  const render = () => {
    if (!root) return;
    const available = ready();
    const state = root.querySelector<HTMLElement>('[data-role="state"]')!;
    state.textContent = !context.ros ? 'ROS unavailable' : !active() ? 'Paused' : !connected() ? 'Disconnected' : failed ? 'Telemetry unavailable' : !recognized ? 'Waiting for Go2' : !live() ? (odometry ? 'Odometry stale' : 'Waiting for odometry') : !motionAvailable() ? 'Waiting for motion status' : motion?.mode === 'recover' ? 'Recovering' : motion?.mode === 'fallen' ? 'Fallen · recovery available' : control ? 'Walking' : 'Ready';
    state.dataset.ready = String(available);
    root.dataset.wide = String(viewport.width >= 580);
    root.querySelectorAll<HTMLButtonElement>('[data-drive], [data-action="stop"]').forEach(button => {
      button.disabled = !available;
      button.dataset.held = String(button.dataset.drive === control);
    });
    root.querySelectorAll<HTMLButtonElement>('[data-motion]').forEach(button => {
      button.disabled = !motionAvailable() || !motion?.policies.includes(button.dataset.motion!) || motion?.mode === 'recover' || (button.dataset.motion === 'stand' && motion?.mode === 'fallen');
    });
    root.querySelector<HTMLElement>('[data-role="policy"]')!.textContent = motionAvailable() ? motion!.reason : 'Waiting for motion status.';
    const retry = root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    retry.hidden = !failed;
    retry.disabled = !active() || !connected();
    const values: Record<string, string> = odometry && live() ? {
      x: `${odometry.x.toFixed(2)} m/s`, y: `${odometry.y.toFixed(2)} m/s`, yaw: `${odometry.yaw.toFixed(2)} rad/s`,
      position: `${odometry.px.toFixed(2)} / ${odometry.py.toFixed(2)} m`,
      heading: `${odometry.heading.toFixed(2)} rad`, height: `${odometry.height.toFixed(2)} m`,
    } : {};
    values.backend = motionAvailable() ? motion!.backend : "—";
    root.querySelectorAll<HTMLElement>('[data-value]').forEach(element => { element.textContent = values[element.dataset.value!] ?? '—'; });
  };
  const stop = (force = false) => {
    const wasMoving = control !== null;
    if (driveTimer !== null) clearInterval(driveTimer);
    driveTimer = null;
    control = null;
    input = null;
    commandEpoch++;
    pendingCommand = false;
    if ((wasMoving || force) && connected()) {
      void publish(ZERO).catch(error => context.logger.warn('Go2 stop failed; the simulator command expires after 0.5 s.', error));
    }
    render();
  };
  const start = (next: DriveControl, owner: string) => {
    if (!ready() || input !== null) return;
    control = next;
    input = owner;
    const epoch = ++commandEpoch;
    const tick = () => {
      if (!ready()) { stop(); return; }
      if (pendingCommand) return;
      pendingCommand = true;
      void publish(velocityForControl(next)).catch(error => {
        if (commandEpoch !== epoch) return;
        stop();
        feedback(`Motion stopped: ${String(error)}. Release the control and try again.`);
      }).finally(() => { if (commandEpoch === epoch) pendingCommand = false; });
    };
    tick();
    driveTimer = setInterval(tick, 50);
    feedback('Release the control to stand.');
    render();
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
        suspend();
        failed = true;
        feedback(`Telemetry failed: ${String(error)}. Retry to reconnect.`);
        render();
      });
    };
    subscribe('/robot_description', 'std_msgs/msg/String', message => { recognized = isGo2Description(message); });
    subscribe('/go2/status', 'std_msgs/msg/String', message => { motion = parseMotionStatus(message); statusAt = motion ? Date.now() : -Infinity; });
    subscribe('/odom', 'nav_msgs/msg/Odometry', message => {
      odometry = parseOdometry(message);
      receivedAt = odometry ? Date.now() : -Infinity;
    });
    monitor = setInterval(() => { if (!ready()) stop(); render(); }, 250);
    feedback('Hold a direction when Go2 is ready.');
    render();
  };
  const keyControl: Record<string, DriveControl> = {
    w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back',
    a: 'turn-left', ArrowLeft: 'turn-left', d: 'turn-right', ArrowRight: 'turn-right', q: 'left', e: 'right',
  };
  const key = (event: KeyboardEvent) => event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-drive]');
    const next = (event.key === 'Enter' || event.key === ' ') && button ? button.dataset.drive as DriveControl : keyControl[key(event)];
    if (next) { event.preventDefault(); if (!event.repeat) start(next, `key:${key(event)}`); }
    else if (event.key === ' ') { event.preventDefault(); stop(true); }
  };
  const onKeyUp = (event: KeyboardEvent) => { if (input === `key:${key(event)}`) { event.preventDefault(); stop(); } };
  const onPointerDown = (event: PointerEvent) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-drive]');
    if (!button || button.disabled || event.button !== 0 || input !== null) return;
    event.preventDefault();
    button.focus();
    button.setPointerCapture?.(event.pointerId);
    start(button.dataset.drive as DriveControl, `pointer:${event.pointerId}`);
  };
  const onPointerUp = (event: PointerEvent) => { if (input === `pointer:${event.pointerId}`) stop(); };
  const onBlur = () => stop();
  const onFocusOut = (event: FocusEvent) => { if (!root?.contains(event.relatedTarget as Node | null)) stop(); };
  const onClick = (event: MouseEvent) => {
    const action = (event.target as Element).closest<HTMLButtonElement>('[data-action], [data-motion]');
    if (!action || action.disabled) return;
    if (action.dataset.motion) {
      stop();
      void context.ros!.publish({topic: '/go2/motion_cmd', messageType: 'std_msgs/msg/String', message: {data: action.dataset.motion}}).then(() => feedback('Motion requested. Watch the policy status for completion.'), error => feedback(`Motion request failed: ${String(error)}`));
    }
    else if (action.dataset.action === 'stop') { stop(true); feedback('Standing requested.'); }
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
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', onBlur);
      listeners.push(context.connection.subscribe(snapshot => {
        const changed = snapshot.generation !== connection.generation || snapshot.status !== connection.status;
        if (changed) { suspend(); failed = false; }
        connection = snapshot;
        reconcile();
      }));
      listeners.push(context.viewport.subscribe(snapshot => { viewport = snapshot; reconcile(); }));
      reconcile();
    },
    setActive(value) { requestedActive = value; reconcile(); },
    unmount() {
      suspend();
      listeners.splice(0).forEach(remove => remove());
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onBlur);
      mountedContainer?.replaceChildren();
      mountedContainer = null;
      root = null;
    },
  };
};

const definition: RoboBoyPanelDefinition = { apiVersion: '2.0.0', id: PANEL_ID, activate: createPanel };
export default definition;
