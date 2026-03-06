use anchor_lang::prelude::*;

// #[constant] exposes this value in the generated IDL so
// TypeScript clients can reference it without hardcoding.
// This seed is unused by the swap logic itself but useful
// as a generic PDA seed example.
#[constant]
pub const SEED: &str = "anchor";

// Every Anchor account begins with an 8-byte discriminator.
// The discriminator is the first 8 bytes of SHA-256("account:<AccountName>").
// Anchor uses it to identify which struct a raw account belongs to,
// preventing one account type from being mis-read as another.
// When calculating how many bytes to allocate for a new account,
// always add ANCHOR_DISCRIMINATOR bytes to the struct's own size.
pub const ANCHOR_DISCRIMINATOR: usize = 8;