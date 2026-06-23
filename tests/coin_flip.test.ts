import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { CoinFlip } from "../target/types/coin_flip";
import {
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";

describe("coin_flip", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CoinFlip as Program<CoinFlip>;
  const authority = provider.wallet;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [playerStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), authority.publicKey.toBuffer()],
    program.programId
  );

  it("initializes and funds the vault (Happy Path: setup)", async () => {
    const bankroll = new BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .initialize(bankroll)
      .accountsPartial({
        authority: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    assert.isAtLeast(vaultBalance, 2 * LAMPORTS_PER_SOL);

    const config = await program.account.config.fetch(configPda);
    assert.ok(config.authority.equals(authority.publicKey));
  });

  it("plays a round and updates player state (Happy Path: bet -> settle)", async () => {
    const wager = new BN(0.1 * LAMPORTS_PER_SOL);

    await program.methods
      .play(wager)
      .accountsPartial({
        player: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        playerState: playerStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ps = await program.account.playerState.fetch(playerStatePda);
    assert.equal(ps.rounds.toNumber(), 1);
    assert.equal(ps.lastWager.toNumber(), 0.1 * LAMPORTS_PER_SOL);
    console.log(`   -> round 1 result: ${ps.lastWon ? "WIN" : "LOSE"}`);
  });

  it("rejects a zero wager (Edge Case: bet 0)", async () => {
    try {
      await program.methods
        .play(new BN(0))
        .accountsPartial({
          player: authority.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: playerStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected ZeroWager error");
    } catch (e: any) {
      assert.include(e.toString(), "ZeroWager");
    }
  });

  it("rejects a wager the vault cannot cover (Edge Case: bet too big)", async () => {
    // wager 大到 2*wager 超过金库余额 -> 应触发 InsufficientVaultFunds
    const huge = new BN(100 * LAMPORTS_PER_SOL);
    try {
      await program.methods
        .play(huge)
        .accountsPartial({
          player: authority.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: playerStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected InsufficientVaultFunds error");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientVaultFunds");
    }
  });
});
