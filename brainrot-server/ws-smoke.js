const WebSocket = require('ws');
const { BrainrotLayout } = require('../server/layout');

const BASE = 'http://localhost:8787';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

function connect(token, serverId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/ws?token=${token}&serverId=${serverId}`);
    const state = { ws, latestState: null, youAre: null, events: [] };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'you_are') { state.youAre = msg; resolve(state); }
      else if (msg.type === 'room_state') state.latestState = msg;
      else if (msg.type === 'event') state.events.push(msg);
    });
    ws.on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const uniq = Date.now();
  const jack = await api('/api/signup', { method: 'POST', body: { username: 'jack' + uniq, password: 'hunter22' } });
  const bob = await api('/api/signup', { method: 'POST', body: { username: 'bob' + uniq, password: 'hunter22' } });

  const created = await api('/api/servers', { method: 'POST', token: jack.token, body: { name: 'WS Test' } });
  const serverId = created.server.id;
  await api('/api/servers/join', { method: 'POST', token: bob.token, body: { code: created.server.code } });

  const jackWs = await connect(jack.token, serverId);
  const bobWs = await connect(bob.token, serverId);
  console.log('jack baseSlot:', jackWs.youAre.baseSlot, ' bob baseSlot:', bobWs.youAre.baseSlot);

  // --- Scenario 1: claim a brainrot off the conveyor belt ---
  let beltItem = null;
  for (let i = 0; i < 100 && !beltItem; i++) {
    await sleep(150);
    beltItem = jackWs.latestState?.belt?.[0] || null;
  }
  if (!beltItem) throw new Error('FAIL: no belt item ever appeared');
  console.log('belt item spawned:', beltItem.brainrot.name, 'at t=', beltItem.t.toFixed(2));

  const chaseInterval = setInterval(() => {
    const item = jackWs.latestState?.belt?.find(b => b.id === beltItem.id);
    if (!item) return;
    const pos = BrainrotLayout.beltPositionAt(item.t);
    jackWs.ws.send(JSON.stringify({ type: 'input', x: pos.x, z: pos.z, facing: 0, moving: true, steal: false }));
  }, 100);

  let claimed = false;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const jackBase = jackWs.latestState.bases.find(b => b.userId === jack.user.id);
    if (jackBase.brainrots.some(Boolean)) { claimed = true; break; }
  }
  clearInterval(chaseInterval);
  if (!claimed) throw new Error('FAIL: jack never managed to claim the belt item');
  // Move jack off the belt AND away from his own base (not just to a fixed
  // point, since a fixed direction can coincidentally land near his own base
  // depending on which slot he was assigned) so scenario 2 tests a genuinely
  // undefended plot.
  const jackHome = BrainrotLayout.baseCenter(jackWs.youAre.baseSlot);
  const fleeTarget = { x: -jackHome.x * 3 - 20, z: -jackHome.z * 3 - 20 };
  const fleeInterval = setInterval(() => {
    jackWs.ws.send(JSON.stringify({ type: 'input', x: fleeTarget.x, z: fleeTarget.z, facing: 0, moving: true, steal: false }));
  }, 100);
  await sleep(2500);
  clearInterval(fleeInterval);
  console.log('PASS: jack claimed a brainrot off the conveyor belt');
  const claimEvent = jackWs.events.find(e => e.kind === 'claimed' && e.userId === jack.user.id);
  if (!claimEvent) throw new Error('FAIL: no "claimed" event was broadcast');
  console.log('PASS: server broadcast a claimed event for the client-side flight animation');

  // --- Scenario 2: undefended plot gets stolen ---
  let jackBase = jackWs.latestState.bases.find(b => b.userId === jack.user.id);
  const plotIndex = jackBase.brainrots.findIndex(Boolean);
  const plotPos = BrainrotLayout.plotWorldPos(jackWs.youAre.baseSlot, plotIndex);

  const tickInput = setInterval(() => {
    bobWs.ws.send(JSON.stringify({ type: 'input', x: plotPos.x, z: plotPos.z, facing: 0, moving: true, steal: true }));
  }, 100);
  await sleep(7000);
  clearInterval(tickInput);
  await sleep(300);

  jackBase = jackWs.latestState.bases.find(b => b.userId === jack.user.id);
  const bobBase = jackWs.latestState.bases.find(b => b.userId === bob.user.id);
  console.log('after steal attempt -> jack plot:', jackBase.brainrots[plotIndex], ' bob has item:', bobBase.brainrots.some(Boolean));
  if (jackBase.brainrots[plotIndex] !== null) throw new Error('FAIL: undefended plot should have been stolen');
  if (!bobBase.brainrots.some(Boolean)) throw new Error('FAIL: bob should now own the stolen brainrot');
  console.log('PASS: undefended steal succeeded end-to-end over the websocket protocol');

  // --- Scenario 3: defended plot is NOT stolen ---
  const bobPlotIndex = bobBase.brainrots.findIndex(Boolean);
  const bobPlotPos = BrainrotLayout.plotWorldPos(bobWs.youAre.baseSlot, bobPlotIndex);

  const defendInterval = setInterval(() => {
    bobWs.ws.send(JSON.stringify({ type: 'input', x: bobPlotPos.x, z: bobPlotPos.z, facing: 0, moving: true, steal: false }));
    jackWs.ws.send(JSON.stringify({ type: 'input', x: bobPlotPos.x, z: bobPlotPos.z, facing: 0, moving: true, steal: true }));
  }, 100);
  await sleep(8000);
  clearInterval(defendInterval);
  await sleep(300);

  const bobBaseAfter = jackWs.latestState.bases.find(b => b.userId === bob.user.id);
  console.log('after defended steal attempt -> bob plot:', bobBaseAfter.brainrots[bobPlotIndex]);
  if (bobBaseAfter.brainrots[bobPlotIndex] === null) throw new Error('FAIL: defended plot should NOT have been stolen');
  console.log('PASS: owner presence correctly blocked the theft');

  jackWs.ws.close();
  bobWs.ws.close();
  console.log('ALL WEBSOCKET SMOKE TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
