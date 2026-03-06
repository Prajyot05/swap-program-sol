use anchor_lang::prelude::*;

// #[error_code] derives anchor_lang::error::Error for this enum.
// Each variant becomes a distinct on-chain error that is surfaced
// in transaction simulation and logs as a named string rather than
// a raw numeric code, making debugging significantly easier.
//
// Anchor error codes start at 6000 to avoid collision with
// Solana's own runtime error codes.
//
// Usage: return Err(error!(ErrorCode::CustomError));
// or:    require!(condition, ErrorCode::CustomError);
#[error_code]
pub enum ErrorCode {
    // Placeholder error — extend this enum with domain-specific
    // variants as the program grows (e.g. OfferExpired, InsufficientFunds).
    #[msg("Custom error message")]
    CustomError,
}
