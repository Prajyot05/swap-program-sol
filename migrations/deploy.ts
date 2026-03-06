// ============================================================
// migrations/deploy.ts
// ============================================================
// Anchor runs this script automatically when you execute
// `anchor migrate` (or implicitly after `anchor deploy`).
//
// Key concepts:
//   • This is NOT a test file — it runs against a real (or local)
//     cluster and is meant for one-time setup tasks such as:
//       - Creating global config PDAs
//       - Seeding initial on-chain state
//       - Transferring admin authority after deployment
//
//   • `provider` is injected by the CLI and is configured from
//     Anchor.toml ([provider] section: cluster + wallet).
//
//   • Because migrations are just TypeScript, you can use the full
//     Anchor / web3.js API here — create accounts, send transactions,
//     read account state, etc.
// ============================================================

import * as anchor from "@coral-xyz/anchor";

module.exports = async function (provider: anchor.AnchorProvider) {
  // Wire up the default provider so all subsequent Anchor calls
  // (program.methods, program.account, etc.) use this connection
  // and fee-payer wallet automatically.
  anchor.setProvider(provider);

  // Add your deploy script here.
  // Example — initialise a global config account:
  //
  //   const program = anchor.workspace.Swap as Program<Swap>;
  //   await program.methods.initialize().accounts({ ... }).rpc();
};
