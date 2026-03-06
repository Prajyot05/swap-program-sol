import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Vite config for the Swap frontend.
// nodePolyfills is required because @solana/web3.js and @coral-xyz/anchor
// depend on Node.js built-ins (Buffer, crypto, stream) that browsers don't
// have natively.
export default defineConfig({
  plugins: [
    nodePolyfills({
      // Buffer is used everywhere in Solana SDKs for byte manipulation.
      include: ["buffer", "crypto", "stream", "util", "assert"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  // Resolve the IDL and generated types from the monorepo root.
  resolve: {
    alias: {
      "@idl": "../target/idl/swap.json",
    },
  },
  define: {
    // Some Solana packages check process.env.NODE_ENV
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
