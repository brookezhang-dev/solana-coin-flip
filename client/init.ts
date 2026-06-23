/**
 * 初始化脚本(Node.js)。
 * 在 devnet 上调用一次 `initialize`:创建 Config PDA,并给 Vault PDA 注入"庄家本金"。
 * 必须先跑这个,金库才有钱赔付,之后才能用 flip.ts 玩。
 *
 * 运行:
 *   ts-node client/init.ts 2          # 给金库注入 2 SOL 本金(默认 2)
 * 环境变量(可选):
 *   RPC_URL=...    默认 devnet
 *   KEYPAIR=...    默认 ~/.config/solana/id.json(这个钱包会成为 authority/庄家)
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
  const bankrollSol = Number(process.argv[2] ?? "2");

  // ---- 连接 & 钱包(authority = 庄家)----
  const connection = new Connection(RPC, "confirmed");
  const keypairPath =
    process.env.KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`;
  const authority = loadKeypair(keypairPath);

  const wallet = new anchor.Wallet(authority);
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

  console.log(`Program:   ${program.programId.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Config PDA:${configPda.toBase58()}`);
  console.log(`Vault PDA: ${vaultPda.toBase58()}`);

  // ---- 幂等保护:如果已经初始化过,直接报告并退出 ----
  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    const config = await program.account.config.fetch(configPda);
    const vaultBalance = await connection.getBalance(vaultPda);
    console.log("-----------------------------------------");
    console.log("⚠️  已经初始化过了(Config 账户已存在),跳过 initialize。");
    console.log(`Authority on-chain: ${config.authority.toBase58()}`);
    console.log(`Total rounds:       ${config.totalRounds.toString()}`);
    console.log(`Vault balance:      ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log("如需追加金库本金,可直接给 Vault PDA 转账,或重新部署一个新程序。");
    return;
  }

  // ---- 调用 initialize ----
  const bankroll = new BN(bankrollSol * LAMPORTS_PER_SOL);
  console.log("-----------------------------------------");
  console.log(`正在初始化,注入金库本金:${bankrollSol} SOL ...`);

  const sig = await program.methods
    .initialize(bankroll)
    .accountsPartial({
      authority: authority.publicKey,
      config: configPda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(sig, "confirmed");

  // ---- 读取结果 ----
  const vaultBalance = await connection.getBalance(vaultPda);
  console.log(`Tx:            https://solscan.io/tx/${sig}?cluster=devnet`);
  console.log(`Vault balance: ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log("✅ 初始化完成,现在可以跑 client/flip.ts 玩一局了。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
