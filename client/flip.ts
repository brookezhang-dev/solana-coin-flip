/**
 * 独立客户端脚本(Node.js)。
 * 用 @solana/web3.js 读取余额、确认交易,用 @coral-xyz/anchor 调用程序。
 *
 * 运行:
 *   ts-node client/flip.ts 0.1          # 押注 0.1 SOL
 * 环境变量(可选):
 *   RPC_URL=...    默认 devnet
 *   KEYPAIR=...    默认 ~/.config/solana/id.json
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { CoinFlip } from "../target/types/coin_flip";
import idl from "../target/idl/coin_flip.json";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

async function main() {
  const wagerSol = Number(process.argv[2] ?? "0.1");

  // ---- 连接 & 钱包 ----
  const connection = new Connection(RPC, "confirmed");
  const keypairPath =
    process.env.KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`;
  const player = loadKeypair(keypairPath);

  const wallet = new anchor.Wallet(player);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // Anchor 0.30+: programId 从 idl.address 读取,构造函数只需 (idl, provider)
  const program = new Program<CoinFlip>(idl as CoinFlip, provider);

  // ---- 派生 PDA ----
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [playerStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), player.publicKey.toBuffer()],
    program.programId
  );

  // ---- 1) 下注前余额 ----
  const before = await connection.getBalance(player.publicKey);
  console.log(`Player:          ${player.publicKey.toBase58()}`);
  console.log(`Balance before:  ${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Wager:           ${wagerSol} SOL`);

  // ---- 2) 调用 play ----
  const wager = new BN(wagerSol * LAMPORTS_PER_SOL);
  const sig = await program.methods
    .play(wager)
    .accountsPartial({
      player: player.publicKey,
      config: configPda,
      vault: vaultPda,
      playerState: playerStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // ---- 3) 等待确认 ----
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`Tx:              https://solscan.io/tx/${sig}?cluster=devnet`);

  // ---- 4) 读取结果 + 新余额 ----
  const ps = await program.account.playerState.fetch(playerStatePda);
  const after = await connection.getBalance(player.publicKey);
  console.log("-----------------------------------------");
  console.log(`Result:          ${ps.lastWon ? "WIN 🎉 (Heads)" : "LOSE 😞 (Tails)"}`);
  console.log(`Rounds / Wins:   ${ps.rounds.toString()} / ${ps.wins.toString()}`);
  console.log(`Balance after:   ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
