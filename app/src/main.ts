// ============================================================
// app/src/main.ts — Swap frontend logic
// ============================================================
// Communicates with the deployed Swap program using:
//   • @solana/web3.js   — low-level Solana RPC / keypair primitives
//   • @coral-xyz/anchor — typed program client built from the IDL
//   • @solana/spl-token — token account helpers
//
// Wallet: relies on window.solana (Phantom / any Solana wallet adapter
// that exposes the Wallet Standard interface on window.solana).
// ============================================================

import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { Swap } from "../../target/types/swap";
// Import the IDL JSON — Anchor uses this to build the typed client.
import IDL from "../../target/idl/swap.json";

// ── Constants ────────────────────────────────────────────────────────────────

// The deployed program's public key.
// Anchor also reads this from IDL.address, but we keep it explicit for
// use when deriving offer PDAs client-side.
const PROGRAM_ID = new PublicKey("A4TZ1aEN2UGfT3wz3Fsjuc4z4VgWqZFcJ3o9DfNbv6LY");

// All mints in this project use Token-2022.  Change to TOKEN_PROGRAM_ID
// if using the classic SPL token program.
const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

// ── Module-level state ───────────────────────────────────────────────────────

// These are null until the user connects their wallet.
let program: Program<Swap> | null = null;
let provider: AnchorProvider | null = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function log(msg: string, type: "info" | "success" | "error" = "info") {
  const el = $<HTMLDivElement>("log");
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(msg)}</span>`;
  // Prepend so newest is at top
  el.prepend(line);
  // Keep the log from growing unbounded
  while (el.children.length > 30) el.removeChild(el.lastChild!);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setLoading(btnId: string, loading: boolean, label: string) {
  const btn = $<HTMLButtonElement>(btnId);
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${label}`;
  } else {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function shorten(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// ── Wallet connection ────────────────────────────────────────────────────────

const connectBtn = $<HTMLButtonElement>("connect-btn");
const walletAddressEl = $<HTMLSpanElement>("wallet-address");
const clusterSelect = $<HTMLSelectElement>("cluster-select");

connectBtn.addEventListener("click", async () => {
  // window.solana is injected by Phantom and other wallets that
  // support the legacy Solana wallet standard.
  const solana = (window as any).solana;
  if (!solana) {
    log("No Solana wallet detected. Install Phantom: https://phantom.app", "error");
    return;
  }

  try {
    // connect() triggers the wallet approval popup.
    await solana.connect();

    const clusterUrl = clusterSelect.value;
    // "confirmed" commitment: waits for a supermajority of validators
    // to confirm the transaction. Safe default for UI interactions.
    const connection = new Connection(clusterUrl, "confirmed");

    // AnchorProvider wires the Connection + Wallet together.
    // The wallet object must implement signTransaction / signAllTransactions
    // which Phantom's window.solana does expose.
    provider = new AnchorProvider(connection, solana, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    // Create the typed Program client.  Casting to `any` is necessary
    // because the IDL JSON doesn't have const-narrowed types at runtime,
    // but the TypeScript type from target/types/swap.ts gives us the
    // correct method signatures.
    program = new Program(IDL as any, provider) as Program<Swap>;

    const pubkey = solana.publicKey.toBase58();
    walletAddressEl.textContent = shorten(pubkey);
    walletAddressEl.title = pubkey;
    walletAddressEl.style.display = "inline";
    connectBtn.textContent = "Connected";
    connectBtn.disabled = true;

    log(`Wallet connected: ${pubkey}`, "success");
    log(`Cluster: ${clusterUrl}`);

    // Observe wallet disconnect / account change
    solana.on("disconnect", () => {
      program = null;
      provider = null;
      connectBtn.textContent = "Connect Wallet";
      connectBtn.disabled = false;
      walletAddressEl.style.display = "none";
      log("Wallet disconnected");
    });
  } catch (err: any) {
    log(`Connection failed: ${err?.message ?? err}`, "error");
  }
});

// ── Tab navigation ───────────────────────────────────────────────────────────

function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll<HTMLElement>(".tab-content").forEach((c) =>
    c.classList.toggle("active", c.id === `tab-${name}`)
  );
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab!));
});

// ── MAKE OFFER ───────────────────────────────────────────────────────────────

$<HTMLFormElement>("make-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!program || !provider) {
    log("Connect your wallet first.", "error");
    return;
  }

  const mintAStr = $<HTMLInputElement>("mint-a").value.trim();
  const mintBStr = $<HTMLInputElement>("mint-b").value.trim();
  const amountA  = parseInt($<HTMLInputElement>("amount-a").value, 10);
  const amountB  = parseInt($<HTMLInputElement>("amount-b").value, 10);

  if (!mintAStr || !mintBStr || isNaN(amountA) || isNaN(amountB)) {
    log("Fill in all fields before submitting.", "error");
    return;
  }

  let tokenMintA: PublicKey, tokenMintB: PublicKey;
  try {
    tokenMintA = new PublicKey(mintAStr);
    tokenMintB = new PublicKey(mintBStr);
  } catch {
    log("Invalid mint address — must be a base58 public key.", "error");
    return;
  }

  setLoading("make-btn", true, "Creating…");

  try {
    // Use the current Unix timestamp as the unique offer ID.
    // In production you may want a random BN (like the test suite does)
    // to avoid collisions if the same wallet makes two offers in the same ms.
    const id = new BN(Date.now());

    // Anchor 0.32 auto-derives `maker_token_account_a`, `offer`, `vault`,
    // `associated_token_program`, and `system_program` from the IDL.
    // We only need to provide accounts that can't be derived:
    //   • tokenMintA / tokenMintB — user-supplied
    //   • tokenProgram — which token program to use
    const tx = await program.methods
      .makeOffer(id, new BN(amountA), new BN(amountB))
      .accounts({
        tokenMintA,
        tokenMintB,
        tokenProgram: TOKEN_PROGRAM,
      } as any)
      .rpc();

    // ── Derive the offer PDA so the user can share it ──────────────
    // Seeds must match exactly what the program uses:
    //   [b"offer", maker_pubkey, id_as_little_endian_u64]
    const [offerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        provider.wallet.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      PROGRAM_ID
    );

    log(`Offer created! TX: ${tx}`, "success");
    log(`Offer PDA: ${offerPda.toBase58()}`);

    // Show the result box so the user can copy the PDA
    const resultBox = $<HTMLDivElement>("make-result");
    const pdaInput  = $<HTMLInputElement>("make-result-pda");
    resultBox.style.display = "block";
    pdaInput.value = offerPda.toBase58();
  } catch (err: any) {
    log(`make_offer failed: ${err?.message ?? err}`, "error");
  } finally {
    setLoading("make-btn", false, "Create Offer");
  }
});

// Copy PDA button
$<HTMLButtonElement>("copy-pda-btn").addEventListener("click", () => {
  const val = $<HTMLInputElement>("make-result-pda").value;
  navigator.clipboard.writeText(val).then(() => {
    $<HTMLButtonElement>("copy-pda-btn").textContent = "copied!";
    setTimeout(() => { $<HTMLButtonElement>("copy-pda-btn").textContent = "copy"; }, 1500);
  });
});

// ── TAKE OFFER: preview ──────────────────────────────────────────────────────

$<HTMLButtonElement>("preview-btn").addEventListener("click", async () => {
  if (!program) { log("Connect your wallet first.", "error"); return; }

  const offerStr = $<HTMLInputElement>("offer-address").value.trim();
  if (!offerStr) { log("Enter an offer address to preview.", "error"); return; }

  let offerPubkey: PublicKey;
  try { offerPubkey = new PublicKey(offerStr); }
  catch { log("Invalid offer address.", "error"); return; }

  try {
    // Fetch and deserialise the on-chain Offer account.
    // The IDL's Borsh schema handles the decoding automatically.
    const offerAccount = await program.account.offer.fetch(offerPubkey);

    $<HTMLElement>("prev-maker").textContent    = shorten(offerAccount.maker.toBase58());
    $<HTMLElement>("prev-token-a").textContent  =
      `${offerAccount.tokenBWantedAmount.toString()} of ${shorten(offerAccount.tokenMintA.toBase58())}`;
    $<HTMLElement>("prev-token-b").textContent  =
      `${offerAccount.tokenBWantedAmount.toString()} of ${shorten(offerAccount.tokenMintB.toBase58())}`;

    $<HTMLElement>("offer-preview").style.display = "flex";
    log(`Previewed offer from maker ${offerAccount.maker.toBase58()}`);
  } catch (err: any) {
    log(`Could not load offer: ${err?.message ?? err}`, "error");
  }
});

// ── TAKE OFFER: submit ───────────────────────────────────────────────────────

$<HTMLFormElement>("take-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!program) { log("Connect your wallet first.", "error"); return; }

  const offerStr = $<HTMLInputElement>("offer-address").value.trim();
  let offerPubkey: PublicKey;
  try { offerPubkey = new PublicKey(offerStr); }
  catch { log("Invalid offer address.", "error"); return; }

  setLoading("take-btn", true, "Taking…");

  try {
    // For take_offer, Anchor 0.32 auto-resolves most accounts via
    // `relations` declared in the IDL:
    //   • maker, token_mint_a, token_mint_b  — read from `offer`
    //   • taker_token_account_a/b            — derived ATAs
    //   • maker_token_account_b              — derived ATA
    //   • vault                              — derived ATA of offer PDA
    // We only need to pass `offer` and `tokenProgram`.
    const tx = await program.methods
      .takeOffer()
      .accounts({
        offer: offerPubkey,
        tokenProgram: TOKEN_PROGRAM,
      } as any)
      .rpc();

    log(`Offer taken! TX: ${tx}`, "success");

    // Clear the form after success
    $<HTMLInputElement>("offer-address").value = "";
    $<HTMLElement>("offer-preview").style.display = "none";

    // Refresh the browse tab if it has been loaded
    if (program) renderOffers();
  } catch (err: any) {
    log(`take_offer failed: ${err?.message ?? err}`, "error");
  } finally {
    setLoading("take-btn", false, "Take Offer");
  }
});

// ── BROWSE OFFERS ────────────────────────────────────────────────────────────

$<HTMLButtonElement>("refresh-btn").addEventListener("click", () => {
  if (!program) { log("Connect your wallet first.", "error"); return; }
  renderOffers();
});

async function renderOffers() {
  if (!program) return;

  const list = $<HTMLDivElement>("offers-list");
  list.innerHTML = `<div class="empty"><span class="spinner"></span>Loading offers…</div>`;

  try {
    // program.account.offer.all() fetches every account owned by the
    // program whose discriminator matches the Offer struct.
    // Under the hood this is a getProgramAccounts RPC call with a
    // memcmp filter on the 8-byte discriminator.
    const offers = await program.account.offer.all();

    if (offers.length === 0) {
      list.innerHTML = `<div class="empty">No open offers found on this cluster.</div>`;
      return;
    }

    list.innerHTML = "";

    offers.forEach(({ publicKey, account }) => {
      const card = document.createElement("div");
      card.className = "offer-card";
      card.innerHTML = `
        <div class="offer-row">
          <span class="label">Offer PDA</span>
          <code title="${publicKey.toBase58()}">${shorten(publicKey.toBase58())}</code>
        </div>
        <div class="offer-row">
          <span class="label">Maker</span>
          <code title="${account.maker.toBase58()}">${shorten(account.maker.toBase58())}</code>
        </div>
        <div class="offer-row">
          <span class="label">Offering (Mint A)</span>
          <code title="${account.tokenMintA.toBase58()}">${shorten(account.tokenMintA.toBase58())}</code>
        </div>
        <div class="offer-row">
          <span class="label">Wanting (Mint B)</span>
          <code title="${account.tokenMintB.toBase58()}">${shorten(account.tokenMintB.toBase58())}</code>
        </div>
        <div class="offer-row">
          <span class="label">Amount B Wanted</span>
          <span class="amount">${account.tokenBWantedAmount.toNumber().toLocaleString()}</span>
        </div>
        <div class="offer-actions">
          <button class="btn-primary btn-sm take-offer-btn"
                  data-offer="${publicKey.toBase58()}">
            Take This Offer
          </button>
        </div>
      `;
      list.appendChild(card);
    });

    // Wire up "Take This Offer" buttons to pre-fill the Take tab
    list.querySelectorAll<HTMLButtonElement>(".take-offer-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $<HTMLInputElement>("offer-address").value = btn.dataset.offer!;
        switchTab("take");
        log(`Pre-filled offer address ${btn.dataset.offer}`);
      });
    });

    log(`Loaded ${offers.length} offer(s)`, "success");
  } catch (err: any) {
    list.innerHTML = `<div class="empty">Failed to load offers — see log.</div>`;
    log(`Failed to fetch offers: ${err?.message ?? err}`, "error");
  }
}
