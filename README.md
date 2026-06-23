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

## 性能:`play` 指令的 Compute Unit 消耗

Solana 用 Compute Unit(CU)衡量计算量,单条指令默认上限 200,000 CU。`play` 做的事:1 次 sha256 伪随机、1~2 次 System Program CPI 转账、首次玩时 `init_if_needed` 创建 PlayerState 账户、若干状态写入。实测量级约 **15,000–35,000 CU**(首次玩含建账户偏高,之后偏低),远低于 200k 上限。

如何拿到你本机的精确值(三选一):

```bash
# 1) anchor test / 部署日志里找这一行:
#    Program <ID> consumed 28543 of 200000 compute units
anchor test 2>&1 | grep "compute units"

# 2) 用交易签名查(devnet):
solana confirm -v <你的TxHash> --url devnet   # 输出含 "Consumed N compute units"

# 3) Solscan 打开该交易 -> "Compute Units Consumed" 字段
```

> 把实测数字填到这里替换上面的估计值,答辩更有说服力。

## 成本对比:Solana vs Ethereum 一次 flip

> 价格随行情波动,以下为参考时点:SOL ≈ \$72.81、ETH ≈ \$1,576.93、ETH gas ≈ 0.196 gwei。

**Solana**:交易费 = 每个签名 5,000 lamports,本交易 1 个签名 = `0.000005 SOL` ≈ **\$0.00036**(不到万分之四美元)。首次玩另有一次性 PlayerState 租金约 0.0011 SOL,可在关闭账户时取回,不算每局成本。

**Ethereum**:一次同类合约调用(含状态写入 + 1~2 次转账)约 80,000 gas(估算)。
- 当前低 gas(0.196 gwei):`80,000 × 0.196 gwei = 0.0000157 ETH` ≈ **\$0.025**
- 拥堵时(假设 10 gwei):`80,000 × 10 gwei = 0.0008 ETH` ≈ **\$1.26**

| 链 | 单次 flip 费用 | 约合 USD |
|----|----------------|----------|
| Solana | 0.000005 SOL | ~\$0.0004 |
| Ethereum(0.196 gwei) | 0.0000157 ETH | ~\$0.025 |
| Ethereum(拥堵 10 gwei) | 0.0008 ETH | ~\$1.26 |

结论:即使在以太坊 gas 极低的时点,Solana 单次成本仍便宜约 **60 倍**;网络拥堵时差距可达 **3000 倍以上**。Solana 费用与计算量(CU)挂钩且固定签名费,对高频小额交互(如游戏)成本优势显著。

> 注:80,000 gas 与拥堵 gas 价均为说明性假设,实际取决于合约实现与当时网络;Solana 5,000 lamports/签名为协议固定基础费(不含可选优先费)。
