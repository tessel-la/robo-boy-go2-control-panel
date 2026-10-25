import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition, { isGo2Description, parseOdometry, parseMotionStatus, velocityForControl, velocityForStick } from '../dist/index.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = { data: `<robot name="go2_description">${['FL','FR','RL','RR'].flatMap(leg =>
  ['hip','thigh','calf'].map(joint => `<joint name="${leg}_${joint}_joint"/>`)).join('')}</robot>` };
const status = { data: JSON.stringify({mode:'stand',reason:'Standing with the recovery policy',backend:'cpu',policies:['walk','stand','recover']}) };
const odom = {
  child_frame_id: 'base', pose: { pose: { position: { x: 1, y: 2, z: .32 },
    orientation: { w: 1, x: 0, y: 0, z: 0 } } },
  twist: { twist: { linear: { x: .2, y: 0, z: 0 }, angular: { x: 0, y: 0, z: .4 } } },
};

async function setup(t, options = {}) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const saved = { document: globalThis.document, window: globalThis.window, DOMParser: globalThis.DOMParser };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, DOMParser: dom.window.DOMParser });
  let connection = { status: 'connected', generation: 1 };
  let viewport = { width: 390, height: 600, isIntersecting: true, isDocumentVisible: true, isActive: true };
  const connectionListeners = new Set(), viewportListeners = new Set();
  const subscriptions = [], publications = [];
  let failSubscribe = options.failSubscribe ?? false;
  let failPublish = false;
  const context = {
    panelId: definition.id, instanceId: 'go2-test', capabilities: ['ros'], storage: null, network: null,
    ros: options.noRos ? null : {
      subscribe: async (spec, callback) => {
        if (failSubscribe) throw new Error('subscription refused');
        const subscription = { spec, callback, removed: false, unsubscribe: async () => { subscription.removed = true; } };
        subscriptions.push(subscription);
        if (options.deferred) await options.deferred;
        return subscription;
      },
      publish: async spec => { if (failPublish) throw new Error('publish refused'); publications.push(spec); },
    },
    connection: { getSnapshot: () => connection, subscribe: listener => { connectionListeners.add(listener); return () => connectionListeners.delete(listener); } },
    viewport: { getSnapshot: () => viewport, subscribe: listener => { viewportListeners.add(listener); return () => viewportListeners.delete(listener); } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const instance = await definition.activate(context);
  const container = document.querySelector('main');
  instance.mount(container);
  await delay(0);
  const root = container.querySelector('.go2');
  root.querySelector('[data-joystick]').getBoundingClientRect = () => ({ left: 0, top: 0, width: 164, height: 164 });
  const emit = (topic, message, includeRemoved = false) => subscriptions.filter(s => s.spec.topic === topic && (includeRemoved || !s.removed)).forEach(s => s.callback(message));
  const key = (type, value, target = root) => target.dispatchEvent(new dom.window.KeyboardEvent(type, { key: value, bubbles: true, cancelable: true }));
  const pointer = (type, target = root, id = 1, position = { clientX: 82, clientY: 82 }) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, button: 0, ...position });
    target.dispatchEvent(event);
  };
  t.after(async () => {
    instance.unmount();
    await delay(0);
    Object.assign(globalThis, saved);
    dom.window.close();
  });
  return {
    instance, context, root, container, subscriptions, publications, emit, key, pointer,
    identify: () => { emit('/robot_description', model); emit('/odom', odom); emit('/go2/status', status); },
    connection: value => { connection = { ...connection, ...value }; connectionListeners.forEach(fn => fn(connection)); },
    viewport: value => { viewport = { ...viewport, ...value }; viewportListeners.forEach(fn => fn(viewport)); },
    failSubscribe: value => { failSubscribe = value; }, failPublish: value => { failPublish = value; },
    listenerCount: () => connectionListeners.size + viewportListeners.size,
  };
}
const moving = item => Object.values(item.message.linear).some(Boolean) || Object.values(item.message.angular).some(Boolean);
const button = (panel, control) => panel.root.querySelector(`[data-drive="${control}"]`);

test('rejects unrelated models and malformed odometry at the control boundary', async t => {
  await setup(t);
  assert.equal(isGo2Description(model), true);
  assert.equal(isGo2Description({ data: model.data.replace('go2_description', 'microduck') }), false);
  assert.equal(isGo2Description({ data: '<robot name="go2_description"/>' }), false);
  assert.equal(isGo2Description({ data: '<bad' }), false);
  assert.equal(parseOdometry({}), null);
  assert.equal(parseOdometry({ ...odom, child_frame_id: 'base_link' }), null);
  const invalid = structuredClone(odom);
  invalid.twist.twist.linear.x = null;
  assert.equal(parseOdometry(invalid), null);
  assert.equal(parseOdometry(odom).height, .32);
  for (const control of ['forward','back','left','right','turn-left','turn-right']) {
    const velocity = velocityForControl(control);
    assert.ok(Math.abs(velocity.x) <= .35 && Math.abs(velocity.y) <= .25 && Math.abs(velocity.yaw) <= 1);
  }
});

test('requires a recognized Go2 plus fresh telemetry and never commands motion on mount', async t => {
  const p = await setup(t);
  assert.equal(button(p, 'forward').disabled, true);
  p.emit('/odom', odom);
  assert.equal(button(p, 'forward').disabled, true);
  p.emit('/robot_description', model);
  p.emit('/go2/status', status);
  assert.equal(button(p, 'forward').disabled, false);
  assert.equal(p.publications.length, 0);
  assert.equal(p.root.querySelector('[data-value="position"]').textContent, '1.00 / 2.00 m');
  assert.match(p.root.querySelector('[data-role="feedback"]').textContent, /Hold a direction/);
});

test('held controls repeat and release outside the tile sends zero', async t => {
  const p = await setup(t); p.identify();
  p.pointer('pointerdown', button(p, 'forward'));
  await delay(115);
  assert.ok(p.publications.filter(moving).length >= 2);
  p.pointer('pointerup', window);
  const count = p.publications.length;
  assert.equal(moving(p.publications.at(-1)), false);
  await delay(75);
  assert.equal(p.publications.length, count);
});

test('keyboard releases and explicit Stop clear movement', async t => {
  const p = await setup(t); p.identify();
  p.key('keydown', 'e');
  assert.equal(p.publications.at(-1).message.linear.y, -.15);
  p.key('keyup', 'e');
  assert.equal(moving(p.publications.at(-1)), false);
  p.key('keydown', 'a');
  p.root.querySelector('[data-action="stop"]').click();
  assert.equal(moving(p.publications.at(-1)), false);
  p.key('keydown', 'Enter', button(p, 'back'));
  assert.equal(p.publications.at(-1).message.linear.x, -.2);
  p.key('keyup', 'Enter', button(p, 'back'));
  assert.equal(moving(p.publications.at(-1)), false);
});

test('pointer cancellation, capture loss and focus loss stop the held command', async t => {
  const p = await setup(t); p.identify();
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    p.pointer('pointerdown', button(p, 'turn-left'));
    if (event === 'blur') window.dispatchEvent(new window.Event('blur'));
    else p.pointer(event, event === 'lostpointercapture' ? button(p, 'turn-left') : window);
    assert.equal(moving(p.publications.at(-1)), false);
  }
});

test('inactive tiles stop, unsubscribe, pause and resubscribe on activation', async t => {
  const p = await setup(t); p.identify();
  p.key('keydown', 'w');
  p.instance.setActive(false);
  assert.equal(moving(p.publications.at(-1)), false);
  assert.ok(p.subscriptions.every(s => s.removed));
  const count = p.publications.length;
  p.emit('/odom', odom, true);
  await delay(75);
  assert.equal(p.publications.length, count);
  p.instance.setActive(true); await delay(0);
  assert.equal(p.subscriptions.filter(s => !s.removed).length, 3);
  assert.equal(button(p, 'forward').disabled, true);
  p.identify(); assert.equal(button(p, 'forward').disabled, false);
  p.viewport({ width: 900 });
  assert.equal(p.root.dataset.wide, 'true');
  p.viewport({ isActive: false });
  assert.ok(p.subscriptions.every(s => s.removed));
});

test('a connection generation change never resumes a held command', async t => {
  const p = await setup(t); p.identify(); p.key('keydown', 'w');
  const old = p.subscriptions.slice();
  p.connection({ generation: 2 }); await delay(0);
  assert.ok(old.every(s => s.removed));
  assert.equal(moving(p.publications.at(-1)), false);
  assert.equal(button(p, 'forward').disabled, true);
  p.identify();
  const count = p.publications.length;
  await delay(75);
  assert.equal(p.publications.length, count);
});

test('stale odometry stops continuous movement', async t => {
  const p = await setup(t);
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  p.identify(); p.key('keydown', 'w');
  now = 3000;
  await delay(75);
  assert.equal(moving(p.publications.at(-1)), false);
  assert.equal(button(p, 'forward').disabled, true);
});

test('subscription errors show Retry and recover without reconnecting', async t => {
  const p = await setup(t, { failSubscribe: true });
  const retry = p.root.querySelector('[data-action="retry"]');
  assert.equal(retry.hidden, false);
  assert.equal(button(p, 'forward').disabled, true);
  p.failSubscribe(false); retry.click(); await delay(0); p.identify();
  assert.equal(button(p, 'forward').disabled, false);
});

test('publish failures stop the repeating command', async t => {
  const p = await setup(t); p.identify();
  p.failPublish(true); p.key('keydown', 'w'); await delay(0);
  assert.match(p.root.querySelector('[data-role="feedback"]').textContent, /Motion stopped/);
  p.failPublish(false);
  await delay(75);
  assert.equal(p.publications.length, 0);
});

test('unmount releases subscriptions that resolve late and is idempotent', async t => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const p = await setup(t, { deferred });
  p.instance.unmount(); resolve(); await delay(0);
  assert.ok(p.subscriptions.every(s => s.removed));
  p.instance.unmount();
  assert.equal(p.container.childElementCount, 0);
  assert.equal(p.listenerCount(), 0);
});

test('missing ROS leaves a usable unavailable state with no timers or commands', async t => {
  const p = await setup(t, { noRos: true });
  assert.equal(button(p, 'forward').disabled, true);
  assert.equal(p.root.querySelector('[data-role="state"]').textContent, 'ROS unavailable');
  assert.equal(p.subscriptions.length, 0);
});


test('learned recovery is explicit and disables walking until standing is acknowledged', async t => {
  const p = await setup(t); p.identify();
  p.root.querySelector('[data-motion="recover"]').click();
  assert.equal(p.publications.at(-1).topic, '/go2/motion_cmd');
  assert.deepEqual(p.publications.at(-1).message, {data:'recover'});
  p.emit('/go2/status', {data:JSON.stringify({mode:'recover',reason:'Recovery requested',backend:'cuda:0',policies:['walk','stand','recover']})});
  assert.equal(button(p,'forward').disabled, true);
  assert.equal(p.root.querySelector('[data-role="state"]').textContent, 'Recovering');
  assert.equal(p.root.querySelector('[data-value="backend"]').textContent, 'cuda:0');
  p.emit('/go2/status', {data:JSON.stringify({mode:'fallen',reason:'Fall detected',backend:'cuda:0',policies:['walk','stand','recover']})});
  assert.equal(p.root.querySelector('[data-motion="recover"]').disabled, false);
  assert.equal(p.root.querySelector('[data-motion="stand"]').disabled, true);
  p.emit('/go2/status', status);
  assert.equal(button(p,'forward').disabled, false);
  assert.equal(parseMotionStatus({data:'null'}),null);
  assert.equal(parseMotionStatus({data:'not JSON'}),null);
});

test('touch stick rejects invalid geometry, has a dead zone and bounds diagonal motion', () => {
  for (const args of [[0, 0, 50], [3, 3, 50], [NaN, 1, 50], [0, 1, 0]]) {
    assert.deepEqual(velocityForStick(...args), { x: 0, y: 0, yaw: 0 });
  }
  const forward = velocityForStick(0, -500, 50);
  assert.equal(forward.x, .2);
  const right = velocityForStick(500, 0, 50);
  assert.equal(right.y, -.15);
  const diagonal = velocityForStick(50, -50, 50);
  assert.ok(Math.abs(Math.hypot(diagonal.x / .2, diagonal.y / .15) - 1) < 1e-10);
  assert.equal(diagonal.yaw, 0);
});

test('two fingers can move and turn; releasing either finger preserves only the other input', async t => {
  const p = await setup(t); p.identify();
  const stick = p.root.querySelector('[data-stick]');
  p.pointer('pointerdown', stick, 1);
  await delay(0);
  p.pointer('pointermove', window, 1, { clientX: 82, clientY: 31 });
  await delay(0);
  p.pointer('pointerdown', button(p, 'turn-right'), 2);
  await delay(60);
  assert.equal(p.publications.at(-1).message.linear.x, .2);
  assert.equal(p.publications.at(-1).message.angular.z, -.4);
  assert.notEqual(stick.style.transform, '');
  p.pointer('pointerup', window, 1);
  await delay(60);
  assert.equal(p.publications.at(-1).message.linear.x, 0);
  assert.equal(p.publications.at(-1).message.angular.z, -.4);
  assert.equal(stick.style.transform, '');
  p.pointer('pointerup', window, 2);
  assert.equal(moving(p.publications.at(-1)), false);
  const count = p.publications.length;
  p.pointer('pointermove', window, 1, { clientX: 82, clientY: 31 });
  await delay(60);
  assert.equal(p.publications.length, count);
});

test('combined keys remain bounded, release independently, and Escape stops every input', async t => {
  const p = await setup(t); p.identify();
  p.key('keydown', 'w'); p.key('keydown', 'q'); p.key('keydown', 'a');
  await delay(60);
  const value = p.publications.at(-1).message;
  assert.ok(Math.hypot(value.linear.x / .2, value.linear.y / .15) <= 1);
  assert.equal(value.angular.z, .4);
  p.key('keyup', 'w'); await delay(60);
  assert.equal(p.publications.at(-1).message.linear.x, 0);
  assert.equal(p.publications.at(-1).message.linear.y, .15);
  p.key('keydown', 'Escape');
  assert.equal(moving(p.publications.at(-1)), false);
  const nativeSpace = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  p.root.querySelector('[data-motion="stand"]').dispatchEvent(nativeSpace);
  assert.equal(nativeSpace.defaultPrevented, false);
});

test('resize and pointer cancellation center the stick without resuming on later pointer moves', async t => {
  const p = await setup(t); p.identify();
  const stick = p.root.querySelector('[data-stick]');
  for (const cancel of ['resize', 'pointercancel', 'lostpointercapture']) {
    p.pointer('pointerdown', stick, 1, { clientX: 82, clientY: 31 });
    if (cancel === 'resize') p.viewport({width: 900});
    else p.pointer(cancel, cancel === 'lostpointercapture' ? stick : window, 1);
    assert.equal(moving(p.publications.at(-1)), false);
    assert.equal(stick.style.transform, '');
    const count = p.publications.length;
    p.pointer('pointermove', window, 1, { clientX: 82, clientY: 31 });
    await delay(60);
    assert.equal(p.publications.length, count);
  }
});

test('visual motion comes from odometry and disappears when motion status expires', async t => {
  const p = await setup(t);
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  p.identify();
  assert.equal(p.root.querySelector('[data-role="speed"]').textContent, '0.20');
  assert.equal(p.root.querySelector('[data-role="activity"]').textContent, 'Moving');
  assert.equal(p.root.querySelector('[data-role="heading"]').style.transform, 'rotate(90deg)');
  p.key('keydown', 'w');
  now = 3000;
  p.emit('/odom', odom); // Fresh odometry cannot make an expired policy status ready.
  assert.equal(moving(p.publications.at(-1)), false);
  assert.equal(button(p, 'forward').disabled, true);
  assert.equal(p.root.querySelector('[data-role="speed"]').textContent, '—');
  assert.equal(p.root.querySelector('[data-role="visual"]').dataset.live, 'false');
  p.emit('/go2/status', status);
  const count = p.publications.length;
  await delay(60);
  assert.equal(p.publications.length, count);
});
