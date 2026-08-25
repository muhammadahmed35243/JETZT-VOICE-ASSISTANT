/** @type {import('next').NextConfig} */
const nextConfig = {
  // No React pages here — this app only serves API routes (webhook +
  // WebSocket). Kept minimal on purpose.

  // ws does its own conditional require() of optional native addons
  // (bufferutil/utf-8-validate) at module load, falling back to a pure-JS
  // path when they're absent. Webpack's static bundling breaks that
  // fallback — confirmed directly in production: a live call crashed the
  // function 6s in with "TypeError: b.unmask is not a function" the
  // moment Telnyx started sending real audio frames, even with neither
  // native addon installed. Excluding ws from the server bundle lets
  // Node's own require() load it untouched at runtime instead.
  serverExternalPackages: ["ws"],
};

module.exports = nextConfig;
