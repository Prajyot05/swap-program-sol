// ============================================================
// tests/swap.ts — full integration test suite for the Swap program
// ============================================================
// These are *integration* tests: they spin up a local validator
// (via `anchor test`), deploy the program, and send real
// transactions over a JSON-RPC connection.
//
// Test runner: Mocha + Chai (configured in Anchor.toml / package.json).
// Framework:   Anchor TypeScript SDK (@coral-xyz/anchor).
// ============================================================

import { randomBytes } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { BN, type Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  type TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import type { Swap } from "../target/types/swap";
import {
  confirmTransaction,
  createAccountsMintsAndTokenAccounts,
  makeKeypairs,
} from "@solana-developers/helpers";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

// Use Token-2022 as the SPL token program for all tests.
// Swapping this to TOKEN_PROGRAM_ID would run the same suite against
// the classic Token program — demonstrating the program's
// token-program-agnostic design (Interface<TokenInterface>).
const TOKEN_PROGRAM: typeof TOKEN_2022_PROGRAM_ID | typeof TOKEN_PROGRAM_ID =
  TOKEN_2022_PROGRAM_ID;

const SECONDS = 1000;

// Mocha marks a test as "slow" when it exceeds half this threshold.
// Network + BPF compilation can easily take 15–30 s, so we set
// a generous threshold to avoid false slow warnings.
const ANCHOR_SLOW_TEST_THRESHOLD = 40 * SECONDS;

// ----------------------------------------------------------------
// Helper: generate a random u64 offer ID
// ----------------------------------------------------------------
// Using random IDs means we can run tests multiple times without
// account-already-exists errors, and it mirrors real usage where
// a client picks a unique ID per offer.
// `size = 8` produces 8 random bytes → a 64-bit integer.
const getRandomBigNumber = (size = 8) => new BN(randomBytes(size));

// ================================================================
// Test suite
// ================================================================
describe("swap", async () => {
  // ----------------------------------------------------------------
  // Provider & program setup
  // ----------------------------------------------------------------
  // AnchorProvider.env() reads ANCHOR_PROVIDER_URL and ANCHOR_WALLET
  // env vars set by `anchor test`.
  // It creates a Connection and a Wallet from the local keypair file.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // The payer is the local wallet that funds all transactions.
  // Cast needed due to https://github.com/coral-xyz/anchor/issues/3122
  const payer = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  // `anchor.workspace.Swap` is typed via the generated IDL at
  // target/types/swap.ts — gives us full TypeScript autocomplete
  // for all instruction methods and account types.
  const program = anchor.workspace.Swap as Program<Swap>;

  // ----------------------------------------------------------------
  // Shared account registry
  // ----------------------------------------------------------------
  // A mutable record we populate in `before()` and then spread
  // into each instruction call.  Anchor matches keys by name to
  // the accounts listed in the program's IDL.
  const accounts: Record<string, PublicKey> = {
    tokenProgram: TOKEN_PROGRAM,
  };

  // ----------------------------------------------------------------
  // Keypair declarations (populated in before())
  // ----------------------------------------------------------------
  let alice: anchor.web3.Keypair; // the "maker" — creates the offer
  let bob: anchor.web3.Keypair;   // the "taker" — accepts the offer
  let tokenMintA: anchor.web3.Keypair; // mint for the offered token
  let tokenMintB: anchor.web3.Keypair; // mint for the wanted token

  // Swap amounts — equal for simplicity.
  // In production a ratio can differ (e.g. 2 token A for 1 token B).
  const tokenAOfferedAmount = new BN(1_000_000);
  const tokenBWantedAmount = new BN(1_000_000);

  // ----------------------------------------------------------------
  // before() — runs once before ALL tests in this describe block
  // ----------------------------------------------------------------
  // Sets up:
  //   • Two funded keypairs (Alice and Bob)
  //   • Two token mints (A and B)
  //   • Four ATAs (one per user per mint), with initial balances
  before(
    "Creates Alice and Bob accounts, 2 token mints, and associated token accounts for both tokens for both users",
    async () => {
      // `createAccountsMintsAndTokenAccounts` is a helper from
      // @solana-developers/helpers that in one call:
      //   1. Creates keypairs for each user.
      //   2. Creates token mints.
      //   3. Creates ATAs and mints initial token amounts.
      //   4. Airdrops SOL so each user can pay transaction fees.
      const usersMintsAndTokenAccounts =
        await createAccountsMintsAndTokenAccounts(
          [
            // Alice starts with:  1_000_000_000 token A, 0 token B
            [1_000_000_000, 0],
            // Bob starts with:    0 token A,    1_000_000_000 token B
            [0, 1_000_000_000],
          ],
          1 * LAMPORTS_PER_SOL, // SOL airdrop per user (for gas)
          connection,
          payer
        );

      const users = usersMintsAndTokenAccounts.users;
      alice = users[0];
      bob = users[1];

      const mints = usersMintsAndTokenAccounts.mints;
      tokenMintA = mints[0];
      tokenMintB = mints[1];

      const tokenAccounts = usersMintsAndTokenAccounts.tokenAccounts;
      // tokenAccounts[userIndex][mintIndex]
      const aliceTokenAccountA = tokenAccounts[0][0];
      const aliceTokenAccountB = tokenAccounts[0][1];
      const bobTokenAccountA = tokenAccounts[1][0];
      const bobTokenAccountB = tokenAccounts[1][1];

      // Populate the shared accounts registry so every test can
      // spread it into .accounts({...accounts}).
      accounts.maker = alice.publicKey;
      accounts.taker = bob.publicKey;
      accounts.tokenMintA = tokenMintA.publicKey;
      accounts.makerTokenAccountA = aliceTokenAccountA;
      accounts.takerTokenAccountA = bobTokenAccountA;
      accounts.tokenMintB = tokenMintB.publicKey;
      accounts.makerTokenAccountB = aliceTokenAccountB;
      accounts.takerTokenAccountB = bobTokenAccountB;
    }
  );

  // ================================================================
  // TEST 1 — make_offer (happy path)
  // ================================================================
  it(
    "Puts the tokens Alice offers into the vault when Alice makes an offer",
    async () => {
      // ----------------------------------------------------------
      // Derive the Offer PDA address client-side
      // ----------------------------------------------------------
      // The on-chain program uses the same seeds; the addresses must
      // match or Anchor will reject the transaction.
      // Seeds: ["offer", maker_pubkey, id_as_little_endian_u64]
      //
      // findProgramAddressSync returns [address, bump].
      // We only need [0] (the address); the program finds the bump itself.
      const offerId = getRandomBigNumber();

      const offer = PublicKey.findProgramAddressSync(
        [
          Buffer.from("offer"),
          accounts.maker.toBuffer(),
          // BN.toArrayLike serialises to an 8-byte little-endian buffer,
          // matching `id.to_le_bytes()` in Rust.
          offerId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      )[0];

      // ----------------------------------------------------------
      // Derive the vault ATA address client-side
      // ----------------------------------------------------------
      // The vault is the ATA of (mint: tokenMintA, owner: offer PDA).
      // `allowOwnerOffCurve = true` is required because the owner is
      // a PDA (not a regular Ed25519 key), which lies off the curve.
      const vault = getAssociatedTokenAddressSync(
        accounts.tokenMintA,
        offer,
        true, // allowOwnerOffCurve
        TOKEN_PROGRAM
      );

      // Save for use in subsequent tests (take_offer needs them).
      accounts.offer = offer;
      accounts.vault = vault;

      // ----------------------------------------------------------
      // Snapshot Alice's token A balance BEFORE the transaction
      // ----------------------------------------------------------
      const aliceBalanceBefore = new BN(
        (
          await connection.getTokenAccountBalance(accounts.makerTokenAccountA)
        ).value.amount
      );

      // ----------------------------------------------------------
      // Send the make_offer instruction
      // ----------------------------------------------------------
      // .accounts() resolves named accounts from the IDL.
      // .signers([alice]) adds Alice's signature — she's the maker.
      // .rpc() sends the transaction and returns the signature string.
      const transactionSignature = await program.methods
        .makeOffer(offerId, tokenAOfferedAmount, tokenBWantedAmount)
        .accounts({ ...accounts })
        .signers([alice])
        .rpc();

      // Wait for the transaction to be confirmed on-chain before
      // reading state.  Without this the RPC might return stale data.
      await confirmTransaction(connection, transactionSignature);

      // ----------------------------------------------------------
      // Assertion 1: vault holds exactly the offered token A amount
      // ----------------------------------------------------------
      // This verifies the CPI transfer from maker → vault succeeded.
      const vaultBalanceResponse =
        await connection.getTokenAccountBalance(vault);
      const vaultBalance = new BN(vaultBalanceResponse.value.amount);
      assert(
        vaultBalance.eq(tokenAOfferedAmount),
        `Vault balance ${vaultBalance} != offered amount ${tokenAOfferedAmount}`
      );

      // ----------------------------------------------------------
      // Assertion 2: Alice's token A balance decreased correctly
      // ----------------------------------------------------------
      const aliceBalanceAfter = new BN(
        (
          await connection.getTokenAccountBalance(accounts.makerTokenAccountA)
        ).value.amount
      );
      assert(
        aliceBalanceBefore.sub(aliceBalanceAfter).eq(tokenAOfferedAmount),
        "Alice's token A balance did not decrease by the offered amount"
      );

      // ----------------------------------------------------------
      // Assertion 3: Offer PDA stores the correct metadata
      // ----------------------------------------------------------
      // program.account.offer.fetch deserialises the raw on-chain
      // account bytes using the IDL's Borsh schema.
      const offerAccount = await program.account.offer.fetch(offer);

      assert(
        offerAccount.maker.equals(alice.publicKey),
        "Offer.maker does not match Alice"
      );
      assert(
        offerAccount.tokenMintA.equals(accounts.tokenMintA),
        "Offer.tokenMintA mismatch"
      );
      assert(
        offerAccount.tokenMintB.equals(accounts.tokenMintB),
        "Offer.tokenMintB mismatch"
      );
      assert(
        offerAccount.tokenBWantedAmount.eq(tokenBWantedAmount),
        "Offer.tokenBWantedAmount mismatch"
      );
      // The bump must be a valid u8 (0–255).
      assert(
        offerAccount.bump >= 0 && offerAccount.bump <= 255,
        "Offer.bump is out of valid range"
      );
    }
  ).slow(ANCHOR_SLOW_TEST_THRESHOLD);

  // ================================================================
  // TEST 2 — take_offer (happy path)
  // ================================================================
  it(
    "Puts the tokens from the vault into Bob's account, and gives Alice Bob's tokens, when Bob takes an offer",
    async () => {
      // ----------------------------------------------------------
      // Snapshot balances BEFORE the transaction
      // ----------------------------------------------------------
      // Bob starts with 0 token A; Alice starts with 0 token B.
      // Recording before-balances lets us assert exact deltas.
      const bobTokenABefore = new BN(
        (
          await connection.getTokenAccountBalance(accounts.takerTokenAccountA)
        ).value.amount
      );
      const aliceTokenBBefore = new BN(
        (
          await connection.getTokenAccountBalance(accounts.makerTokenAccountB)
        ).value.amount
      );
      const bobSolBefore = await connection.getBalance(bob.publicKey);

      // ----------------------------------------------------------
      // Send the take_offer instruction
      // ----------------------------------------------------------
      // Bob is the taker — he signs with his keypair.
      // No amount parameters needed: they are read from the Offer PDA on-chain.
      const transactionSignature = await program.methods
        .takeOffer()
        .accounts({ ...accounts })
        .signers([bob])
        .rpc();

      await confirmTransaction(connection, transactionSignature);

      // ----------------------------------------------------------
      // Assertion 1: Bob received the offered token A from the vault
      // ----------------------------------------------------------
      const bobTokenAAfter = new BN(
        (
          await connection.getTokenAccountBalance(accounts.takerTokenAccountA)
        ).value.amount
      );
      assert(
        bobTokenAAfter.sub(bobTokenABefore).eq(tokenAOfferedAmount),
        `Bob's token A balance did not increase by ${tokenAOfferedAmount}; got +${bobTokenAAfter.sub(bobTokenABefore)}`
      );

      // ----------------------------------------------------------
      // Assertion 2: Alice received the wanted token B from Bob
      // ----------------------------------------------------------
      const aliceTokenBAfter = new BN(
        (
          await connection.getTokenAccountBalance(accounts.makerTokenAccountB)
        ).value.amount
      );
      assert(
        aliceTokenBAfter.sub(aliceTokenBBefore).eq(tokenBWantedAmount),
        `Alice's token B balance did not increase by ${tokenBWantedAmount}`
      );

      // ----------------------------------------------------------
      // Assertion 3: Offer PDA is closed (account no longer exists)
      // ----------------------------------------------------------
      // After take_offer the program zeroes and closes the Offer PDA.
      // getAccountInfo returns null when the account does not exist.
      const offerAccountInfo = await connection.getAccountInfo(accounts.offer);
      assert(
        offerAccountInfo === null,
        "Offer PDA should be closed after take_offer"
      );

      // ----------------------------------------------------------
      // Assertion 4: Vault token account is closed
      // ----------------------------------------------------------
      // The vault is closed inside close_offer via close_account CPI.
      // Lamports go to Bob (taker) as a gas-cost subsidy.
      const vaultAccountInfo = await connection.getAccountInfo(accounts.vault);
      assert(
        vaultAccountInfo === null,
        "Vault token account should be closed after take_offer"
      );

      // ----------------------------------------------------------
      // Assertion 5: Bob's SOL balance did not drop unexpectedly
      // ----------------------------------------------------------
      // The vault's rent-exempt reserve (~0.002 SOL) is returned to Bob,
      // offsetting the transaction fee he pays.  We use a loose bound
      // because exact fee amounts vary with transaction size/priority.
      const bobSolAfter = await connection.getBalance(bob.publicKey);
      assert(
        bobSolAfter > bobSolBefore - 0.01 * LAMPORTS_PER_SOL,
        "Bob's SOL balance dropped more than expected — vault rent may not have been reclaimed"
      );
    }
  ).slow(ANCHOR_SLOW_TEST_THRESHOLD);

  // ================================================================
  // TEST 3 — make_offer with a non-1:1 ratio
  // ================================================================
  // Verifies that the program stores the maker's exact terms verbatim
  // for any combination of offered vs. wanted amounts.
  it("Correctly records non-equal token amounts in a second offer", async () => {
    const offerId = getRandomBigNumber();

    // Alice offers 500k token A but only wants 250k token B back (2:1 ratio).
    const offerAAmount = new BN(500_000);
    const wantBAmount = new BN(250_000);

    const offer = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        accounts.maker.toBuffer(),
        offerId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const vault = getAssociatedTokenAddressSync(
      accounts.tokenMintA,
      offer,
      true,
      TOKEN_PROGRAM
    );

    // Assign to an intermediate variable to avoid TypeScript's excess property
    // checking on inline object literals (a known TS quirk — variables are not
    // subject to the same strict check as object literals passed directly).
    const test3Accounts = { ...accounts, offer, vault };
    await confirmTransaction(
      connection,
      await program.methods
        .makeOffer(offerId, offerAAmount, wantBAmount)
        .accounts(test3Accounts)
        .signers([alice])
        .rpc()
    );

    // Vault must hold the offered amount exactly — not more, not less.
    const vaultBalance = new BN(
      (await connection.getTokenAccountBalance(vault)).value.amount
    );
    assert(
      vaultBalance.eq(offerAAmount),
      `Vault should hold ${offerAAmount}, got ${vaultBalance}`
    );

    // The Offer PDA must record the wanted amount, not the offered amount.
    const offerAccount = await program.account.offer.fetch(offer);
    assert(
      offerAccount.tokenBWantedAmount.eq(wantBAmount),
      `Stored wanted amount ${offerAccount.tokenBWantedAmount} != ${wantBAmount}`
    );
  }).slow(ANCHOR_SLOW_TEST_THRESHOLD);

  // ================================================================
  // TEST 4 — multiple simultaneous offers from the same maker
  // ================================================================
  // The `id` seed component lets one maker hold N open offers at once.
  // This test creates two offers at different IDs and verifies both
  // Offer PDAs have independent on-chain state.
  it("Allows a maker to have multiple simultaneous open offers", async () => {
    const offerId1 = getRandomBigNumber();
    const offerId2 = getRandomBigNumber();

    // Derive both PDA addresses independently — they must differ.
    const offer1 = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        accounts.maker.toBuffer(),
        offerId1.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const offer2 = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        accounts.maker.toBuffer(),
        offerId2.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const vault1 = getAssociatedTokenAddressSync(
      accounts.tokenMintA,
      offer1,
      true,
      TOKEN_PROGRAM
    );

    const vault2 = getAssociatedTokenAddressSync(
      accounts.tokenMintA,
      offer2,
      true,
      TOKEN_PROGRAM
    );

    // Create both offers sequentially (two init instructions for the
    // same payer in one tx requires careful ordering; sequential is simpler).
    const test4Accounts1 = { ...accounts, offer: offer1, vault: vault1 };
    await confirmTransaction(
      connection,
      await program.methods
        .makeOffer(offerId1, new BN(100_000), new BN(100_000))
        .accounts(test4Accounts1)
        .signers([alice])
        .rpc()
    );

    const test4Accounts2 = { ...accounts, offer: offer2, vault: vault2 };
    await confirmTransaction(
      connection,
      await program.methods
        .makeOffer(offerId2, new BN(200_000), new BN(200_000))
        .accounts(test4Accounts2)
        .signers([alice])
        .rpc()
    );

    // The two PDA addresses must be distinct.
    assert(!offer1.equals(offer2), "Two offers with different IDs must produce different PDAs");

    // Each offer must store its own independent terms.
    const offerAccount1 = await program.account.offer.fetch(offer1);
    const offerAccount2 = await program.account.offer.fetch(offer2);

    assert(
      offerAccount1.tokenBWantedAmount.eq(new BN(100_000)),
      "Offer 1 wanted amount mismatch"
    );
    assert(
      offerAccount2.tokenBWantedAmount.eq(new BN(200_000)),
      "Offer 2 wanted amount mismatch"
    );
  }).slow(ANCHOR_SLOW_TEST_THRESHOLD);
});
