use anchor_lang::prelude::*;

// #[account] does several things:
//   • Implements anchor_lang::AccountSerialize / AccountDeserialize
//     using Borsh encoding (compact binary format, not JSON).
//   • Adds an 8-byte discriminator prefix automatically.
//   • Implements AccountOwner, asserting the account is owned by
//     this program — Anchor checks this on every instruction.
//
// #[derive(InitSpace)] auto-calculates the byte size of this struct
// so we can write `space = ANCHOR_DISCRIMINATOR + Offer::INIT_SPACE`
// without manually summing field sizes.
//   u64  = 8 bytes
//   Pubkey = 32 bytes
//   u8   = 1 byte
//   Total fields: 8 + 32 + 32 + 32 + 8 + 1 = 113 bytes
//   +8 discriminator → 121 bytes allocated on-chain.
#[account]
#[derive(InitSpace)]
pub struct Offer {
    // Unique identifier chosen by the maker at creation time.
    // Combined with the maker's pubkey as a PDA seed, allowing
    // one maker to have multiple open offers simultaneously.
    pub id: u64,

    // The public key of the wallet that created (and funded) this offer.
    // Used as a PDA seed and to route refund lamports on close.
    pub maker: Pubkey,

    // The mint of the token the maker is *offering*.
    // Stored here so the taker (and the program) can verify that
    // the vault holds the correct token and that nothing has been
    // swapped mid-flight.
    pub token_mint_a: Pubkey,

    // The mint of the token the maker *wants* in return.
    pub token_mint_b: Pubkey,

    // How many token B units the maker demands from the taker.
    // This is the swap rate — taker must send exactly this
    // amount or the instruction will fail.
    pub token_b_wanted_amount: u64,

    // The canonical bump seed for this PDA.
    // Stored at creation so future instructions can reconstruct
    // the PDA signer without calling find_program_address (which
    // iterates and is slightly more expensive in compute units).
    pub bump: u8,
}