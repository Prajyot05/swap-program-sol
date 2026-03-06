// ============================================================
// SWAP PROGRAM — lib.rs (entry point)
// ============================================================
// This is the root crate file. Anchor reads this to:
//   1. Discover the on-chain program ID (declare_id!).
//   2. Generate the IDL (Interface Definition Language) JSON
//      that client-side SDKs use to interact with the program.
//   3. Route incoming instructions to the correct handler.
//
// Design pattern: "thin" entrypoint handlers that delegate to
// module-level helpers.  This keeps lib.rs readable and puts
// heavy logic in purpose-built files.
// ============================================================

// Declare sub-modules — Rust will look for
//   src/constants.rs, src/error.rs, etc.
pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

// Pull everything into scope from anchor_lang.
// anchor_lang::prelude re-exports the most common Anchor and
// Solana types: AccountInfo, Pubkey, Result, msg!, Context, etc.
use anchor_lang::prelude::*;

// Re-export every public symbol from each sub-module so callers
// can write `use swap::Offer` instead of `use swap::state::offer::Offer`.
pub use constants::*;
pub use instructions::*;
pub use state::*;

// declare_id! hard-codes the program's public key.
// At deploy time Anchor verifies this matches the keypair in
// target/deploy/swap-keypair.json.  If they differ, the program
// will refuse to execute (security boundary).
declare_id!("A4TZ1aEN2UGfT3wz3Fsjuc4z4VgWqZFcJ3o9DfNbv6LY");

// The #[program] macro transforms the module into an Anchor
// program.  Each `pub fn` inside becomes a distinct on-chain
// instruction that can be called by clients.
#[program]
pub mod swap {
    use super::*;

    // ----------------------------------------------------------
    // INSTRUCTION: make_offer
    // ----------------------------------------------------------
    // Called by the *maker* (Alice) to create a swap offer.
    //
    // Parameters:
    //   id                   — a client-chosen u64 used to make
    //                          the offer PDA unique per maker.
    //   token_a_offered_amount — how many token A the maker
    //                          deposits into the vault.
    //   token_b_requested_amount — how many token B the maker
    //                          wants in return.
    //
    // What happens on-chain:
    //   1. `send_offered_tokens_to_vault`: CPI to the token
    //      program to transfer token A from maker → vault.
    //   2. `save_offer`: initialise the Offer PDA account with
    //      all relevant metadata so the taker can verify terms.
    //
    // The `?` operator returns early with the error if any step
    // fails, ensuring atomicity within a single transaction.
    pub fn make_offer(
        ctx: Context<MakeOffer>,
        id: u64,
        token_a_offered_amount: u64,
        token_b_requested_amount: u64,
    ) -> Result<()> {
        instructions::make_offer::send_offered_tokens_to_vault(&ctx, token_a_offered_amount)?;
        instructions::make_offer::save_offer(ctx, id, token_b_requested_amount)
    }

    // ----------------------------------------------------------
    // INSTRUCTION: take_offer
    // ----------------------------------------------------------
    // Called by the *taker* (Bob) to fulfil an existing offer.
    //
    // No parameters beyond the accounts — all needed values
    // (e.g. token_b_wanted_amount) are read from the Offer PDA.
    //
    // What happens on-chain (all within one atomic transaction):
    //   1. Transfer token B from taker → maker.
    //   2. Transfer token A from vault → taker (PDA signs).
    //   3. Close the vault token account (rent returned to taker).
    //   4. The `close = maker` constraint on the Offer account
    //      reclaims the rent lamports back to the maker.
    pub fn take_offer(ctx: Context<TakeOffer>) -> Result<()> {
        instructions::take_offer::send_requested_tokens_to_maker(&ctx)?;
        instructions::take_offer::send_offered_tokens_to_taker(&ctx)?;
        instructions::take_offer::close_offer(ctx)?;
        Ok(())
    }
}
