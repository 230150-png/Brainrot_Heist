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

  // Jack hatches a brainrot on his own base.
  jackWs.ws.send(JSON.stringify({ type: 'hatch' }));
  await sleep(400);
  let jackBase = jackWs.latestState.bases.find(b => b.userId === jack.user.id);
  const plotIndex = jackBase.brainrots.findIndex(Boolean);
  console.log('jack hatched at plot', plotIndex, jackBase.brainrots[plotIndex]);
  if (plotIndex === -1) throw new Error('FAIL: jack has no brainrot after hatching');

  // --- Scenario 1: undefended plot gets stolen ---
  const plotPos = BrainrotLayout.plotWorldPos(jackWs.youAre.baseSlot, plotIndex);
  const tickInput = setInterval(() => {
    bobWs.ws.send(JSON.stringify({ type: 'input', x: plotPos.x, z: plotPos.z, facing: 0, moving: true, steal: true }));
  }, 100);
  await sleep(7000); // enough time to travel from spawn to the plot AND complete STEAL_TIME
  clearInterval(tickInput);
  await sleep(300);

  jackBase = jackWs.latestState.bases.find(b => b.userId === jack.user.id);
  const bobBase = jackWs.latestState.bases.find(b => b.userId === bob.user.id);
  console.log('after steal attempt -> jack plot:', jackBase.brainrots[plotIndex], ' bob has item:', bobBase.brainrots.some(Boolean));
  if (jackBase.brainrots[plotIndex] !== null) throw new Error('FAIL: undefended plot should have been stolen');
  if (!bobBase.brainrots.some(Boolean)) throw new Error('FAIL: bob should now own the stolen brainrot');
  console.log('PASS: undefended steal succeeded end-to-end over the websocket protocol');

  // --- Scenario 2: defended plot is NOT stolen (jack tries to steal back from bob's base, bob defends) ---
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
