// ============================================================
// INSTRUCTION: make_offer
// ============================================================
// The maker (Alice) calls this instruction to:
//   1. Deposit token A into a program-controlled vault.
//   2. Record the swap terms in an Offer PDA account.
//
// After this instruction is confirmed, the offer is *live* —
// any taker can call take_offer to fulfil it.
// ============================================================

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    // token_interface lets us support both the legacy Token program
    // and the newer Token-2022 program with the same code.
    token_interface::{Mint, TokenAccount, TokenInterface},
};

// `crate::` anchors the path at lib.rs, regardless of how deeply
// nested the current file is.  Avoids fragile `super::super::` chains.
use crate::{ANCHOR_DISCRIMINATOR, Offer, transfer_tokens};

// ----------------------------------------------------------------
// Account validation struct — MakeOffer
// ----------------------------------------------------------------
// #[derive(Accounts)] generates a `try_accounts` function that:
//   • Deserialises every account from the runtime-provided slice.
//   • Runs all the constraint attributes (#[account(...)]) as checks.
//   • Returns a typed struct on success, or an error on failure.
//
// #[instruction(id: u64)] makes the `id` argument from the
// instruction data available inside constraint expressions so we
// can use it in the seeds array.
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct MakeOffer<'info> {
    // `mut` is required whenever lamports or data of an account will
    // change.  The maker pays for newly created accounts, so their
    // balance will decrease — hence `mut`.
    #[account(mut)]
    pub maker: Signer<'info>,

    // `mint::token_program = token_program` verifies that this mint
    // was created by the same token program that the instruction
    // is using.  Prevents mixing Token and Token-2022 mints.
    #[account(mint::token_program = token_program)]
    pub token_mint_a: InterfaceAccount<'info, Mint>,

    // Token B mint — the maker specifies what they want in return.
    // We don't read or write its balance here; it's recorded in the
    // Offer PDA so the taker knows which token to send.
    #[account(mint::token_program = token_program)]
    pub token_mint_b: InterfaceAccount<'info, Mint>,

    // The maker's existing token A account.  Must be mutable because
    // we will debit `token_a_offered_amount` from it.
    // associated_token constraints verify this ATA was derived from
    // the correct (mint, authority, token_program) triple.
    #[account(
        mut,
        associated_token::mint = token_mint_a,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    pub maker_token_account_a: InterfaceAccount<'info, TokenAccount>,

    // ---- Offer PDA ----
    // `init` allocates a new account on-chain.
    //   payer  — who funds the rent-exempt deposit (the maker).
    //   space  — bytes to allocate: discriminator + all struct fields.
    //   seeds  — deterministic inputs that Anchor hashes to derive
    //            the PDA address.  Using ["offer", maker, id] means
    //            ONE maker can have MANY simultaneous offers.
    //   bump   — Anchor finds the canonical bump automatically and
    //            stores it in ctx.bumps.offer for us to save.
    //
    // PDAs are public keys that have NO private key, therefore only
    // the program (knowing the seeds+bump) can "sign" for them via
    // invoke_signed.  This is how programs own vaults safely.
    #[account(
        init,
        payer = maker,
        space = ANCHOR_DISCRIMINATOR + Offer::INIT_SPACE,
        seeds = [b"offer", maker.key().as_ref(), id.to_le_bytes().as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    // ---- Vault (Associated Token Account owned by the Offer PDA) ----
    // `init` creates a brand-new ATA.
    //   associated_token::authority = offer  — the PDA IS the owner,
    //     so only the program can move tokens out (by signing with
    //     PDA seeds in a CpiContext::new_with_signer call).
    //
    // Why an ATA?  Associated Token Accounts have deterministic
    // addresses (owner + mint), so any client can recreate the vault
    // address without storing it, just like a regular ATA.
    #[account(
        init,
        payer = maker,
        associated_token::mint = token_mint_a,
        associated_token::authority = offer,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    // Required system programs:
    //   System Program  — creates new on-chain accounts.
    //   Token Program   — performs the SPL token transfer.
    //   AssociatedToken — derives / initialises the ATA for the vault.
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ----------------------------------------------------------------
// Step 1: move offered tokens from maker → vault
// ----------------------------------------------------------------
// Takes `&Context` (shared borrow) rather than `Context` (owned)
// so the same context can be used again for `save_offer`.
pub fn send_offered_tokens_to_vault(
    ctx: &Context<MakeOffer>,
    token_a_offered_amount: u64,
) -> Result<()> {
    // Delegate to the shared helper.  The maker is the authority
    // (Signer) so no PDA signing is needed here.
    transfer_tokens(
        &ctx.accounts.maker_token_account_a,
        &ctx.accounts.vault,
        &token_a_offered_amount,
        &ctx.accounts.token_mint_a,
        &ctx.accounts.maker,
        &ctx.accounts.token_program,
    )?;
    Ok(())
}

// ----------------------------------------------------------------
// Step 2: populate the Offer PDA with swap metadata
// ----------------------------------------------------------------
// Takes `Context` by *value* (ownership), consuming it.
// This is the last function called for this instruction, so
// consuming the context is fine and lets Anchor do final cleanup.
pub fn save_offer(
    ctx: Context<MakeOffer>,
    id: u64,
    token_b_requested_amount: u64,
) -> Result<()> {
    // set_inner is the idiomatic, safe way to write all fields of an
    // Anchor account at once.  It serialises the struct into the
    // account's raw data buffer with the discriminator intact.
    ctx.accounts.offer.set_inner(Offer {
        id,
        maker: ctx.accounts.maker.key(),
        token_mint_a: ctx.accounts.token_mint_a.key(),
        token_mint_b: ctx.accounts.token_mint_b.key(),
        token_b_wanted_amount: token_b_requested_amount,
        // ctx.bumps is a struct Anchor populates automatically for every
        // PDA in the Accounts struct.  Saving the bump avoids the cost
        // of calling find_program_address in future instructions.
        bump: ctx.bumps.offer,
    });
    Ok(())
}
