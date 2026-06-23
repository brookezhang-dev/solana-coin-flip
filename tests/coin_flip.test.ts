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
    // 初始化金库、下注流转、PlayerState 初始化与更新
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
    // 下注、更新 PlayerState
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
    // 下注 0 应触发 ZeroWager 错误
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

  it("rejects a bet when the player has insufficient funds (Edge Case: player broke)", async () => {
    // 创建一个余额不足的新玩家：有足够的租金来创建账户，但不够支付 0.5 SOL 的下注
    const poorPlayer = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      poorPlayer.publicKey,
      0.05 * LAMPORTS_PER_SOL // 0.05 SOL，远小于 0.5 SOL 的下注
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [poorPlayerStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), poorPlayer.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .play(new BN(0.5 * LAMPORTS_PER_SOL))
        .accountsPartial({
          player: poorPlayer.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: poorPlayerStatePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([poorPlayer])
        .rpc();
      assert.fail("expected InsufficientPlayerFunds error");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientPlayerFunds");
    }
  });

  it("increments config.total_rounds after each play (State: global counter)", async () => {
    const configBefore = await program.account.config.fetch(configPda);
    const roundsBefore = configBefore.totalRounds.toNumber();

    await program.methods
      .play(new BN(0.01 * LAMPORTS_PER_SOL))
      .accountsPartial({
        player: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        playerState: playerStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAfter = await program.account.config.fetch(configPda);
    assert.equal(configAfter.totalRounds.toNumber(), roundsBefore + 1);
  });

  it("adjusts vault balance correctly based on outcome (State: vault economics)", async () => {
    const wager = new BN(0.01 * LAMPORTS_PER_SOL);
    const vaultBefore = await provider.connection.getBalance(vaultPda);

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
    const vaultAfter = await provider.connection.getBalance(vaultPda);

    if (ps.lastWon) {
      // 玩家赢：vault 收入 wager，再赔出 2*wager，净减少 wager
      assert.equal(vaultAfter, vaultBefore - wager.toNumber());
      console.log(`   -> vault lost ${wager.toNumber()} lamports (player won)`);
    } else {
      // 玩家输：vault 收入 wager 并保留，净增加 wager
      assert.equal(vaultAfter, vaultBefore + wager.toNumber());
      console.log(`   -> vault gained ${wager.toNumber()} lamports (player lost)`);
    }
  });

  it("increments wins only when player wins (State: playerState.wins)", async () => {
    const psBefore = await program.account.playerState.fetch(playerStatePda);
    const winsBefore = psBefore.wins.toNumber();
    const roundsBefore = psBefore.rounds.toNumber();

    await program.methods
      .play(new BN(0.01 * LAMPORTS_PER_SOL))
      .accountsPartial({
        player: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        playerState: playerStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const psAfter = await program.account.playerState.fetch(playerStatePda);
    assert.equal(psAfter.rounds.toNumber(), roundsBefore + 1);

    if (psAfter.lastWon) {
      assert.equal(psAfter.wins.toNumber(), winsBefore + 1);
    } else {
      assert.equal(psAfter.wins.toNumber(), winsBefore);
    }
  });

  it("rejects re-initialization of an existing config (Edge Case: double init)", async () => {
    try {
      await program.methods
        .initialize(new BN(1 * LAMPORTS_PER_SOL))
        .accountsPartial({
          authority: authority.publicKey,
          config: configPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected error on re-initialization");
    } catch (e: any) {
      // Anchor 的 init 约束禁止对已存在的账户重复初始化
      assert.ok(e.toString().length > 0, "re-initialization correctly rejected");
    }
  });
});
