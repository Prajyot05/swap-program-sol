// ============================================================
// INSTRUCTION: take_offer
// ============================================================
// The taker (Bob) calls this instruction to accept an open offer.
//
// What happens atomically in one transaction:
//   1. Taker sends token B to the maker.
//   2. Program (acting as the offer PDA) sends token A from
//      the vault to the taker.
//   3. Vault token account is closed; rent goes to taker.
//   4. Offer PDA is closed (via `close = maker` constraint);
//      rent goes to maker.
//
// Because all of this is in one transaction, either EVERYTHING
// succeeds or NOTHING changes — no partial swap is possible.
// ============================================================

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        // Struct describing the accounts needed for a transfer_checked CPI.
        TransferChecked,
        // The actual CPI function for a checked token transfer.
        transfer_checked,
        // Struct and function for closing a token account.
        CloseAccount,
        close_account,
        Mint,
        TokenAccount,
        TokenInterface,
    },
};

use crate::{Offer, transfer_tokens};

// ----------------------------------------------------------------
// Account validation struct — TakeOffer
// ----------------------------------------------------------------
#[derive(Accounts)]
pub struct TakeOffer<'info> {
    // The taker pays for any newly created ATAs they don't have yet.
    #[account(mut)]
    pub taker: Signer<'info>,

    // SystemAccount (not Signer) — maker doesn't sign the take_offer
    // transaction.  The program verifies the maker via the `has_one`
    // constraint on the offer account.  `mut` is required because the
    // maker receives SOL (rent) back when the offer PDA is closed.
    #[account(mut)]
    pub maker: SystemAccount<'info>,

    // No constraints needed on the mints themselves here; their
    // correctness is enforced transitively:  the Offer PDA stores
    // token_mint_a and token_mint_b, and `has_one` verifies that
    // these accounts match what was recorded at make_offer time.
    pub token_mint_a: InterfaceAccount<'info, Mint>,
    pub token_mint_b: InterfaceAccount<'info, Mint>,

    // ---- Taker's token accounts ----
    // `init_if_needed` creates the ATA when it doesn't exist, or
    // re-uses it when it does.  This prevents the instruction from
    // failing when the taker has never held token A or B before.
    // Requires the `init-if-needed` feature on anchor-lang (see Cargo.toml).
    //
    // Box<> heap-allocates the account reference.  The Solana stack
    // is limited to 4 KB; boxing large accounts prevents stack overflows.
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_a,
        associated_token::authority = taker,
        associated_token::token_program = token_program
    )]
    pub taker_token_account_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_b,
        associated_token::authority = taker,
        associated_token::token_program = token_program
    )]
    pub taker_token_account_b: Box<InterfaceAccount<'info, TokenAccount>>,

    // ---- Maker's token B account ----
    // `init_if_needed` handles the case where the maker has never
    // received token B before (they may have only held token A).
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_b,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    pub maker_token_account_b: InterfaceAccount<'info, TokenAccount>,

    // ---- Offer PDA ----
    // `close = maker` — after this instruction, the PDA account is
    //   zero-filled and its rent lamports are sent to `maker`.
    // `has_one = maker` — ensures offer.maker == accounts.maker.key().
    //   Prevents a taker from passing a different maker account.
    // `has_one = token_mint_a/b` — ensures the mints provided match
    //   what the maker originally recorded.  Prevents mint substitution.
    // `seeds + bump` — re-derives the PDA to confirm the address is
    //   correct.  Using `offer.bump` (saved at creation) instead of
    //   find_program_address saves compute units.
    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = token_mint_a,
        has_one = token_mint_b,
        seeds = [b"offer", maker.key().as_ref(), offer.id.to_le_bytes().as_ref()],
        bump = offer.bump
    )]
    pub offer: Account<'info, Offer>,

    // ---- Vault ----
    // The token A vault PDA-owned ATA we're draining.
    // Mutable because its balance will go to zero.
    #[account(
        mut,
        associated_token::mint = token_mint_a,
        associated_token::authority = offer,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ----------------------------------------------------------------
// Step 1: transfer token B from taker → maker
// ----------------------------------------------------------------
// Uses the shared helper because the taker is a real Signer —
// no PDA signing needed.
pub fn send_requested_tokens_to_maker(ctx: &Context<TakeOffer>) -> Result<()> {
    transfer_tokens(
        &ctx.accounts.taker_token_account_b,
        &ctx.accounts.maker_token_account_b,
        // Read the required amount from the on-chain Offer record;
        // impossible to pass a tampered value from the client.
        &ctx.accounts.offer.token_b_wanted_amount,
        &ctx.accounts.token_mint_b,
        &ctx.accounts.taker,
        &ctx.accounts.token_program,
    )?;
    Ok(())
}

// ----------------------------------------------------------------
// Step 2: transfer token A from vault → taker
// ----------------------------------------------------------------
// The vault is owned by the Offer PDA, so the program must sign
// on behalf of that PDA using `CpiContext::new_with_signer`.
pub fn send_offered_tokens_to_taker(ctx: &Context<TakeOffer>) -> Result<()> {
    // Reconstruct the PDA signing seeds.
    // This MUST match the seeds used at account creation in make_offer:
    //   [b"offer", maker_pubkey_bytes, id_little_endian_bytes]
    // The runtime verifies that hashing these seeds + this program's
    // ID produces the offer account's public key.
    let seeds = &[
        b"offer",
        ctx.accounts.maker.to_account_info().key.as_ref(),
        &ctx.accounts.offer.id.to_le_bytes(),
        &[ctx.accounts.offer.bump], // canonical bump, never iterate
    ];

    // `signer_seeds` is a slice-of-slices (&[&[&[u8]]]).
    // The outer slice holds multiple PDAs that should sign;
    // here we only need the one offer PDA to sign.
    let signer_seeds = &[&seeds[..]];

    // Build the TransferChecked CPI accounts struct.
    let accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.taker_token_account_a.to_account_info(),
        mint: ctx.accounts.token_mint_a.to_account_info(),
        // The OFFER PDA is the authority over the vault, not the taker.
        authority: ctx.accounts.offer.to_account_info(),
    };

    // `new_with_signer` attaches the PDA seeds so the runtime can
    // validate the synthetic signature for the PDA.
    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        accounts,
        signer_seeds,
    );

    // Transfer the ENTIRE vault balance (not a partial amount)
    // to ensure the vault can be closed cleanly afterward.
    transfer_checked(
        cpi_context,
        ctx.accounts.vault.amount,
        ctx.accounts.token_mint_a.decimals,
    )?;

    Ok(())
}

// ----------------------------------------------------------------
// Step 3: close the vault token account and the Offer PDA
// ----------------------------------------------------------------
// Closes the vault (recovering rent for the taker) then lets
// Anchor close the Offer PDA via the `close = maker` constraint.
pub fn close_offer(ctx: Context<TakeOffer>) -> Result<()> {
    // Re-derive the PDA signer seeds (same as in send_offered_tokens_to_taker).
    // Each function that CPIs as the PDA must reconstruct the seeds locally.
    let seeds = &[
        b"offer",
        ctx.accounts.maker.to_account_info().key.as_ref(),
        &ctx.accounts.offer.id.to_le_bytes()[..],
        &[ctx.accounts.offer.bump],
    ];

    let signer_seeds = [&seeds[..]];

    // ---- Close the vault token account ----
    // After draining the vault we close it to:
    //   a) reclaim rent lamports for the taker (reward for executing).
    //   b) clean up on-chain state — good citizenship on Solana.
    let accounts = CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        // Destination for the recovered rent lamports.
        destination: ctx.accounts.taker.to_account_info(),
        authority: ctx.accounts.offer.to_account_info(),
    };

    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        accounts,
        &signer_seeds,
    );

    close_account(cpi_context)?;

    // The Offer PDA itself is closed automatically by Anchor at the
    // end of the instruction because of the `close = maker` constraint
    // declared on the `offer` field in TakeOffer.  No explicit CPI needed.

    Ok(())
}