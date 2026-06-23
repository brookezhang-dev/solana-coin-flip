# Solana Coin Flip DApp (Anchor)

把传统 EVM 抛硬币赌博合约的逻辑翻译到 Solana(SVM)账户模型:玩家用 SOL 下注,资金托管进程序拥有的 PDA 金库,链上结算输赢。

## Program ID (Devnet)

```
<部署后填入,运行 `solana address -k target/deploy/coin_flip-keypair.json` 或 `anchor keys list` 获取>
```

## 本地运行客户端

```bash
# 1. 安装依赖
yarn install

# 2. 编译并部署到 devnet(详见下方"部署步骤")
anchor build
anchor deploy --provider.cluster devnet

# 3. 初始化(只需一次):给金库注入庄家本金
#    可在 tests 里完成,或单独写一个 init 脚本。

# 4. 玩一局,押注 0.1 SOL
RPC_URL=https://api.devnet.solana.com ts-node client/flip.ts 0.1
```

## 资金流向图

```
                      下注 wager (CPI: 玩家签名)
   玩家钱包  ───────────────────────────────────►  Vault PDA (seeds=["vault"])
      ▲                                                    │
      │            赢: 付 2 × wager                         │
      │     (CPI: 程序用 vault seeds 签名 invoke_signed)     │
      └────────────────────────────────────────────────────┘
                      输: 资金留在 Vault(归庄家)
```

- 输:玩家 → 金库 1×,金库净 +1×。
- 赢:玩家 → 金库 1×,金库 → 玩家 2×,金库净 −1×。
- 所以需要 `initialize` 预先给金库注入本金,否则第一次赢无法支付。

## PDA 策略(为什么用 PDA 而不是普通 Keypair)

- **Config PDA** `seeds = ["config"]`:全局唯一,任何人都能用相同种子推导出地址,不需要保存私钥。
- **Vault PDA** `seeds = ["vault"]`:持有所有托管资金。**关键**:PDA 没有私钥,只有派生它的程序能用 `seeds + bump` 通过 `invoke_signed` 代表它签名转出资金。如果用普通 Keypair 当金库,私钥一旦泄露资金就被盗;PDA 把"谁能动钱"约束死在程序逻辑里。
- **PlayerState PDA** `seeds = ["player", player_pubkey]`:每个玩家一个,种子里带玩家公钥,天然隔离,且 `init_if_needed` 不会被他人重复初始化(payer 与种子都绑定玩家本人)。

## 安全模型

- **谁付租金(rent)**:`initialize` 里 Config 账户由 authority 付租金;`play` 里 PlayerState 账户由玩家本人付租金(`payer = player`)。Vault 是纯 SOL 账户,靠庄家本金保持租金豁免余额。
- **防止未授权提款**:转出金库的唯一路径是 `play` 指令里 `won == true` 的分支,且由 Vault PDA 的 `seeds` 签名。外部账户拿不到 PDA 私钥(根本不存在),无法绕过程序直接动金库。`play` 要求 `player` 是 `Signer`,确保操作者是玩家本人。

## EVM vs SVM 对比

| 维度 | Solidity (EVM) | Anchor (SVM) |
|------|----------------|--------------|
| 收款 | `payable` 函数,`msg.value` 自动到合约余额 | 没有 payable;需显式 CPI 调用 System Program 的 `transfer` 把 SOL 转入 PDA |
| 状态存储 | 合约内 `mapping`/`storage` 与代码同体 | 代码(Program)与状态(Account)分离,状态存在独立账户里,需预分配空间并付租金 |
| 资金托管权限 | 合约地址即权限,`address(this).transfer` | 金库是 PDA,转出需用 `seeds + bump` 做 `invoke_signed` 签名 |
| 随机数 | 同样无安全原生随机(常用 Chainlink VRF) | 同样无;demo 用 Clock/slot 哈希,生产用 Switchboard VRF |
| 账户传递 | 调用时无需声明用到哪些存储 | 必须在指令里显式列出所有读写账户(账户模型) |

## 随机数说明

本 demo 用 `Clock(unix_timestamp + slot)` + 玩家公钥 + 局数 做哈希取奇偶,**属于伪随机,可被出块者预测**,仅用于教学。生产环境应接入 Switchboard VRF 或 Solana 的可验证随机方案。
