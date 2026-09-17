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

  exportObj.BrainrotLayout = {
    BASE_RADIUS,
    PLOT_OFFSETS,
    PLOTS_PER_BASE: PLOT_OFFSETS.length,
    baseCenter,
    baseFacingAngle,
    plotWorldPos,
    spawnPos,
  };
})(typeof module !== 'undefined' ? module.exports : window);
