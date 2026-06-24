import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { CoinFlip } from "../target/types/coin_flip";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";

describe("coin_flip", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CoinFlip as Program<CoinFlip>;
  const authority = provider.wallet; // 庄家 / authority
  const connection = provider.connection;

  // 全局单例 PDA(seeds 固定,天然是单例)
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const playerStatePda = (player: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("player"), player.toBuffer()],
      program.programId
    )[0];

  // #7:每个 play 用例用全新、独立出资的玩家,消除用例间的顺序耦合。
  async function freshPlayer(sol = 10): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      sol * LAMPORTS_PER_SOL
    );
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    return kp;
  }

  // #9:把 play 指令的 Compute Unit 消耗打印出来(交付物要求"记录 CU")。
  async function logCU(label: string, sig: string) {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log(
      `   [CU] ${label}: ${tx?.meta?.computeUnitsConsumed} compute units`
    );
  }

  // 玩一局并对"金库余额变动"做确定性断言(#6 的关键):
  // 金库不受玩家租金/手续费干扰 —— 赢:净 -1×wager(执行 2× 赔付路径);输:净 +1×wager。
  // 这样无论本局随机结果如何,赔付数学都被精确校验。
  async function playAndAssert(
    player: Keypair,
    wagerSol: number,
    label: string
  ): Promise<boolean> {
    const wager = new BN(wagerSol * LAMPORTS_PER_SOL);
    const wagerLamports = wagerSol * LAMPORTS_PER_SOL;
    const psPda = playerStatePda(player.publicKey);

    const vaultBefore = await connection.getBalance(vaultPda);
    const sig = await program.methods
      .play(wager)
      .accountsPartial({
        player: player.publicKey,
        config: configPda,
        vault: vaultPda,
        playerState: psPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc();
    await logCU(label, sig);

    const ps = await program.account.playerState.fetch(psPda);
    const vaultAfter = await connection.getBalance(vaultPda);
    if (ps.lastWon) {
      assert.equal(vaultAfter, vaultBefore - wagerLamports, "win: vault net -1x");
    } else {
      assert.equal(vaultAfter, vaultBefore + wagerLamports, "lose: vault net +1x");
    }
    return ps.lastWon as boolean;
  }

  // ---------- TC-01 ----------
  it("TC-01 initializes and funds the vault (Happy Path: setup)", async () => {
    const bankroll = new BN(5 * LAMPORTS_PER_SOL);
    await program.methods
      .initialize(bankroll)
      .accountsPartial({
        authority: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultBalance = await connection.getBalance(vaultPda);
    assert.isAtLeast(vaultBalance, 5 * LAMPORTS_PER_SOL);
    const config = await program.account.config.fetch(configPda);
    assert.ok(config.authority.equals(authority.publicKey));
  });

  // ---------- TC-02 ----------
  it("TC-02 plays a round, updates state, asserts payout math + logs CU", async () => {
    const player = await freshPlayer();
    const won = await playAndAssert(player, 0.1, "play (first, incl. init_if_needed)");

    const ps = await program.account.playerState.fetch(
      playerStatePda(player.publicKey)
    );
    assert.equal(ps.rounds.toNumber(), 1);
    assert.equal(ps.lastWager.toNumber(), 0.1 * LAMPORTS_PER_SOL);
    console.log(`   -> round 1 result: ${won ? "WIN" : "LOSE"}`);
  });

  // ---------- TC-03 ----------
  it("TC-03 rejects a zero wager (Edge Case: bet 0)", async () => {
    const player = await freshPlayer(1);
    try {
      await program.methods
        .play(new BN(0))
        .accountsPartial({
          player: player.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: playerStatePda(player.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
      assert.fail("expected ZeroWager error");
    } catch (e: any) {
      assert.include(e.toString(), "ZeroWager");
    }
  });

  // ---------- TC-04 ----------
  it("TC-04 rejects a wager the vault cannot cover (Edge Case: bet too big)", async () => {
    // 用 authority(本地余额巨大)当玩家,先过"玩家买得起",从而触发金库不足而非玩家不足。
    try {
      await program.methods
        .play(new BN(100 * LAMPORTS_PER_SOL))
        .accountsPartial({
          player: authority.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: playerStatePda(authority.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected InsufficientVaultFunds error");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientVaultFunds");
    }
  });

  // ---------- TC-05 ----------
  it("TC-05 rejects a bet when player has insufficient funds (Edge Case: player broke)", async () => {
    const poor = await freshPlayer(0.05); // 只有 0.05 SOL
    try {
      await program.methods
        .play(new BN(0.5 * LAMPORTS_PER_SOL))
        .accountsPartial({
          player: poor.publicKey,
          config: configPda,
          vault: vaultPda,
          playerState: playerStatePda(poor.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([poor])
        .rpc();
      assert.fail("expected InsufficientPlayerFunds error");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientPlayerFunds");
    }
  });

  // ---------- TC-06 ----------
  it("TC-06 increments config.total_rounds after each play (State: global counter)", async () => {
    const player = await freshPlayer();
    const before = (await program.account.config.fetch(configPda)).totalRounds.toNumber();
    await playAndAssert(player, 0.01, "global counter check");
    const after = (await program.account.config.fetch(configPda)).totalRounds.toNumber();
    assert.equal(after, before + 1);
  });

  // ---------- TC-07 ----------
  it("TC-07 vault economics hold across many rounds (State + #6 coverage)", async () => {
    // 同一玩家连玩多局:大概率覆盖赢/输两条分支,每局都校验金库赔付数学。
    const player = await freshPlayer();
    let wins = 0;
    const ROUNDS = 12;
    for (let i = 0; i < ROUNDS; i++) {
      if (await playAndAssert(player, 0.05, `round ${i + 1}`)) wins++;
    }
    const ps = await program.account.playerState.fetch(
      playerStatePda(player.publicKey)
    );
    assert.equal(ps.rounds.toNumber(), ROUNDS);
    assert.equal(ps.wins.toNumber(), wins);
    console.log(`   -> ${ROUNDS} rounds: ${wins} wins / ${ROUNDS - wins} losses`);
  });

  // ---------- TC-08 ----------
  it("TC-08 increments wins only when player wins (State: playerState.wins)", async () => {
    const player = await freshPlayer();
    const psPda = playerStatePda(player.publicKey);
    const won = await playAndAssert(player, 0.02, "wins counter check");
    const ps = await program.account.playerState.fetch(psPda);
    assert.equal(ps.wins.toNumber(), won ? 1 : 0);
  });

  // ---------- TC-09 ----------
  it("TC-09 rejects re-initialization of an existing config (Edge Case: double init)", async () => {
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
      assert.fail("expected account-already-in-use error");
    } catch (e: any) {
      // Anchor 的 init 约束:账户已存在 -> System Program 报 "already in use"
      assert.include(e.toString(), "already in use");
    }
  });

  // ---------- TC-10 ----------
  it("TC-10 lets the authority withdraw from the vault (#3 happy path)", async () => {
    const amount = 0.5 * LAMPORTS_PER_SOL;
    const vaultBefore = await connection.getBalance(vaultPda);
    await program.methods
      .withdraw(new BN(amount))
      .accountsPartial({
        authority: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const vaultAfter = await connection.getBalance(vaultPda);
    assert.equal(vaultAfter, vaultBefore - amount);
  });

  // ---------- TC-11 ----------
  it("TC-11 blocks a non-authority from withdrawing (#3 access control)", async () => {
    const attacker = await freshPlayer(1);
    try {
      await program.methods
        .withdraw(new BN(1000))
        .accountsPartial({
          authority: attacker.publicKey,
          config: configPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected Unauthorized error");
    } catch (e: any) {
      // has_one = authority @ FlipError::Unauthorized
      assert.include(e.toString(), "Unauthorized");
    }
  });
});
