// Shared between server and browser: works as a CommonJS module under Node
// and as a plain global (window.BrainrotLayout) in the browser via a <script>
// tag. Keeping this identical on both sides means "am I near my own plot"
// and "am I in steal range" mean the same thing server-side and client-side.
(function (exportObj) {
  const BASE_RADIUS = 17;
  // Six plots per base, arranged in the same 3x2 grid the solo game used.
  const PLOT_OFFSETS = [
    [-3, -1.4], [0, -1.4], [3, -1.4],
    [-3, 1.4], [0, 1.4], [3, 1.4],
  ];

  function baseCenter(slot) {
    const angle = (slot / 6) * Math.PI * 2;
    return { x: BASE_RADIUS * Math.sin(angle), z: -BASE_RADIUS * Math.cos(angle) };
  }
  function baseFacingAngle(slot) {
    // The angle a base "faces" (outward from the circle's center), used to
    // orient the base's zone tile and fence on the client.
    return (slot / 6) * Math.PI * 2;
  }
  function plotWorldPos(slot, plotIndex) {
    const c = baseCenter(slot);
    const off = PLOT_OFFSETS[plotIndex];
    return { x: c.x + off[0], z: c.z + off[1] };
  }
  function spawnPos(slot) {
    const c = baseCenter(slot);
    // A few units toward the middle of the field from the player's own base.
    const angle = baseFacingAngle(slot);
    return { x: c.x - Math.sin(angle) * 5, z: c.z + Math.cos(angle) * 5 };
  }

  // The conveyor belt runs diagonally through the center of the field, angled
  // at 30°/210° so it passes through the gap between adjacent bases instead
  // of through any base itself (each of the 6 bases sits ~8.5 units clear of
  // this line).
  const BELT_ANGLE_START_DEG = 30;
  const BELT_ANGLE_END_DEG = 210;
  const BELT_RADIUS = 15;
  function beltEndpoint(deg) {
    const rad = (deg / 180) * Math.PI;
    return { x: BELT_RADIUS * Math.sin(rad), z: -BELT_RADIUS * Math.cos(rad) };
  }
  const BELT_START = beltEndpoint(BELT_ANGLE_START_DEG);
  const BELT_END = beltEndpoint(BELT_ANGLE_END_DEG);
  const BELT_LENGTH = Math.hypot(BELT_END.x - BELT_START.x, BELT_END.z - BELT_START.z);
  function beltPositionAt(t) {
    const ct = Math.max(0, Math.min(1, t));
    return { x: BELT_START.x + (BELT_END.x - BELT_START.x) * ct, z: BELT_START.z + (BELT_END.z - BELT_START.z) * ct };
  }

  exportObj.BrainrotLayout = {
    BASE_RADIUS,
    PLOT_OFFSETS,
    PLOTS_PER_BASE: PLOT_OFFSETS.length,
    baseCenter,
    baseFacingAngle,
    plotWorldPos,
    spawnPos,
    BELT_START,
    BELT_END,
    BELT_LENGTH,
    beltPositionAt,
  };
})(typeof module !== 'undefined' ? module.exports : window);
