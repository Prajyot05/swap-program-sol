use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface, TransferChecked, transfer_checked,
};

// ----------------------------------------------------------------
// transfer_tokens — generic token CPI helper
// ----------------------------------------------------------------
// Wraps `transfer_checked` (the safe variant of SPL token transfer)
// for use by any instruction that moves tokens with a regular
// Signer authority (not a PDA).  When the authority IS a PDA, use
// CpiContext::new_with_signer directly (as done in take_offer.rs).
//
// Why `transfer_checked` over `transfer`?
//   transfer_checked additionally requires the mint and the number
//   of decimals, making it impossible to accidentally transfer from
//   an account of the *wrong* mint — a common attack vector.
//
// Lifetime `'info`: Anchor passes account references that must live
// at least as long as the instruction execution.  The `'info`
// lifetime ties all AccountInfo references to the same lifetime
// so the borrow checker can verify nothing is freed early.
pub fn transfer_tokens<'info>(
    // Source token account.  InterfaceAccount<TokenAccount> accepts
    // both the legacy SPL Token program and Token-2022 accounts.
    from: &InterfaceAccount<'info, TokenAccount>,
    // Destination token account.
    to: &InterfaceAccount<'info, TokenAccount>,
    // Number of base units (smallest denomination) to transfer.
    amount: &u64,
    // The mint is required by transfer_checked to verify the
    // decimals and that `from`/`to` are accounts of this mint.
    mint: &InterfaceAccount<'info, Mint>,
    // The wallet that has authority over the `from` account and
    // must sign the transaction.
    authority: &Signer<'info>,
    // The token program to CPI into.  Using Interface<TokenInterface>
    // lets the program work with EITHER the classic Token program
    // (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) or Token-2022
    // (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    // Build the CPI accounts struct.  Anchor will verify that these
    // accounts are actually owned by `token_program` before executing.
    let transfer_accounts_options = TransferChecked {
        from: from.to_account_info(),
        to: to.to_account_info(),
        authority: authority.to_account_info(),
        mint: mint.to_account_info(),
    };

    // CpiContext bundles the program to call with the accounts it
    // needs.  `new` (vs `new_with_signer`) is used when the authority
    // is a real Signer, not a PDA.
    let cpi_ctx = CpiContext::new(token_program.to_account_info(), transfer_accounts_options);

    // Perform the transfer.  `mint.decimals` is passed so the token
    // program can verify amount is consistent with precision.
    // `.map_err` intercepts any error to emit a diagnostic log
    // message before propagating it up the call stack.
    transfer_checked(cpi_ctx, *amount, mint.decimals)
        .map_err(|err| {
            msg!("Error transferring tokens: {:?}", err);
            err
        })?;

    Ok(())
}