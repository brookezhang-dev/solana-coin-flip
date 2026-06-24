# 🪙 Solana Coin Flip DApp

基于 Anchor 0.31.1 的链上抛硬币游戏。玩家用 SOL 下注，资金托管进程序持有的 PDA 金库，链上伪随机结算输赢——赢得 2× 奖金，输则资金留在金库。

---

## 在线体验

**▶ [https://solana-coin-flip-ten.vercel.app/](https://solana-coin-flip-ten.vercel.app/)**

连接 Phantom 钱包（切到 Devnet）+ 领测试币即可直接玩，无需安装任何开发工具。

---

## Program ID（Devnet）

```
FWwP3TsYbpgdZtAnqmM3kEjvUZU1RnXuD1RMjvmXt4qV
```

---

## 项目结构

```
solana-coin-flip/
├── programs/coin_flip/src/lib.rs   # 链上程序：initialize + play 两条指令
├── tests/coin_flip.test.ts         # 11 个本地集成测试（Mocha + Chai）
├── client/
│   ├── init.ts                     # CLI：devnet 初始化金库（一次性）
│   └── flip.ts                     # CLI：devnet 玩一局
├── web/index.html                  # 浏览器前端（单文件，无构建）
├── Anchor.toml                     # 工作区配置
├── Cargo.toml                      # Rust workspace
├── package.json                    # Node 脚本与依赖
├── vercel.json                     # Vercel 静态托管配置
└── DEPLOY.md                       # 完整部署手册
```

---

## 使用方式

### 方式一：网页版（无需开发环境）

1. 安装 [Phantom 钱包](https://phantom.app/)浏览器插件
2. 在 Phantom 设置中把网络切换到 **Devnet**
3. 前往 [https://faucet.solana.com](https://faucet.solana.com) 领取 devnet 测试 SOL
4. 打开 [https://solana-coin-flip-ten.vercel.app/](https://solana-coin-flip-ten.vercel.app/)，点击「连接 Phantom 钱包」
5. 输入押注金额 → 点击「抛硬币」→ 在 Phantom 中签名

---

### 方式二：命令行客户端（devnet）

> 前提：已完成下方「环境安装」和「部署」步骤，或使用已部署的 Program ID。

```bash
# 安装依赖
yarn install

# 初始化金库（仅需一次，给庄家本金注资 2 SOL）
yarn init:vault 2

# 玩一局，押注 0.1 SOL
yarn flip 0.1
```

**`yarn flip` 输出示例：**

```
Player:          <你的地址>
Balance before:  4.8800 SOL
Wager:           0.1 SOL
Tx:              https://solscan.io/tx/<HASH>?cluster=devnet
-----------------------------------------
Result:          WIN 🎉 (Heads)
Rounds / Wins:   3 / 2
Balance after:   4.9700 SOL
```

**环境变量（可选）：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RPC_URL` | `https://api.devnet.solana.com` | 自定义 RPC 节点 |
| `KEYPAIR` | `~/.config/solana/id.json` | 指定钱包密钥对路径 |

```bash
# 示例：使用自定义 RPC 和密钥
RPC_URL=https://your-rpc.com KEYPAIR=~/my-wallet.json yarn flip 0.5
```

---

### 方式三：本地测试

```bash
# 一条命令完成：编译 → 启动本地验证节点 → 部署 → 跑 11 个测试 → 停止节点
anchor test
```

**预期输出：**

```
coin_flip
  ✔ TC-01 initializes and funds the vault (Happy Path: setup)
  ✔ TC-02 plays a round, updates state, asserts payout math + logs CU
  ✔ TC-03 rejects a zero wager (Edge Case: bet 0)
  ✔ TC-04 rejects a wager the vault cannot cover (Edge Case: bet too big)
  ✔ TC-05 rejects a bet when player has insufficient funds (Edge Case: player broke)
  ✔ TC-06 increments config.total_rounds after each play (State: global counter)
  ✔ TC-07 vault economics hold across many rounds (State + payout coverage)
  ✔ TC-08 increments wins only when player wins (State: playerState.wins)
  ✔ TC-09 rejects re-initialization of an existing config (Edge Case: double init)
  ✔ TC-10 lets the authority withdraw from the vault (#3 happy path)
  ✔ TC-11 blocks a non-authority from withdrawing (#3 access control)

11 passing
```

> 输出里每个 play 用例会打印一行 `[CU] ...: NNNNN compute units`,即该笔 `play` 的实测 Compute Unit 消耗(交付物要求的 CU 记录)。

已有构建产物时可跳过编译：

```bash
anchor test --skip-build
```

### 测试用例详情

测试文件：`tests/coin_flip.test.ts`  
框架：Mocha + Chai，通过 `AnchorProvider.env()` 连接 localnet，真实调用链上程序。  
每个 `play` 用例使用**独立新建并出资的玩家**(`freshPlayer()` airdrop),互不依赖、可独立运行(修复了早期"顺序共享状态"的耦合)。Config/Vault 为全局单例,由 TC-01 初始化一次。

---

#### TC-01 · Happy Path：初始化并注资金库

```
initializes and funds the vault (Happy Path: setup)
```

| 项 | 值 |
|----|----|
| 调用指令 | `initialize(bankroll = 2 SOL)` |
| 账户 | authority · Config PDA · Vault PDA · SystemProgram |

**断言：**
- `getBalance(vaultPda) >= 2 × LAMPORTS_PER_SOL` — 金库余额达标
- `config.authority == authority.publicKey` — 管理员地址正确写入

---

#### TC-02 · Happy Path：正常下注并结算

```
plays a round and updates player state (Happy Path: bet -> settle)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 0.1 SOL)` |
| 账户 | player · Config PDA · Vault PDA · PlayerState PDA · SystemProgram |

**断言：**
- `playerState.rounds == 1` — 局数正确递增
- `playerState.lastWager == 0.1 × LAMPORTS_PER_SOL` — 押注额正确记录
- `playerState.lastWon`（打印赢/输，不断言——结果由伪随机决定）

---

#### TC-03 · Edge Case：拒绝零押注

```
rejects a zero wager (Edge Case: bet 0)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 0)` |
| 期望行为 | 交易失败，抛出程序错误 |

**断言：**
- 错误信息包含 `ZeroWager`（对应 `lib.rs` 的 `require!(wager > 0, FlipError::ZeroWager)`）

---

#### TC-04 · Edge Case：拒绝金库无力赔付的超大押注

```
rejects a wager the vault cannot cover (Edge Case: bet too big)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 100 SOL)` |
| 触发条件 | `2 × wager (200 SOL) > vaultBalance (≈2 SOL)` |
| 期望行为 | 交易失败，抛出程序错误 |

**断言：**
- 错误信息包含 `InsufficientVaultFunds`（程序在结算前检查金库是否能赔付 2×）

---

#### TC-05 · Edge Case：拒绝玩家余额不足的下注

```
rejects a bet when the player has insufficient funds (Edge Case: player broke)
```

| 项 | 值 |
|----|----|
| 玩家 | 新生成 Keypair，airdrop **0.05 SOL** |
| 调用指令 | `play(wager = 0.5 SOL)` |
| 触发条件 | `playerBalance (≈0.05 SOL) < wager (0.5 SOL)` |
| 期望行为 | 交易失败，抛出程序错误 |

**断言：**
- 错误信息包含 `InsufficientPlayerFunds`

> 此用例使用独立 Keypair（`.signers([poorPlayer])`），不影响主账户状态。

---

#### TC-06 · State：全局轮数计数器正确递增

```
increments config.total_rounds after each play (State: global counter)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 0.01 SOL)` |
| 读取时机 | 指令调用前后各 fetch 一次 Config 账户 |

**断言：**
- `configAfter.totalRounds == configBefore.totalRounds + 1`（无论输赢，每局必须 +1）

---

#### TC-07 · State：金库余额随结果精确变化

```
adjusts vault balance correctly based on outcome (State: vault economics)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 0.01 SOL)` |
| 读取时机 | 调用前后各 `getBalance(vaultPda)` |

**断言（分支）：**

| 结果 | 断言 | 说明 |
|------|------|------|
| 玩家赢 | `vaultAfter == vaultBefore − wager` | 收入 wager，赔出 2×wager，净 −wager |
| 玩家输 | `vaultAfter == vaultBefore + wager` | 收入 wager 并保留，净 +wager |

---

#### TC-08 · State：胜场计数器仅在赢时递增

```
increments wins only when player wins (State: playerState.wins)
```

| 项 | 值 |
|----|----|
| 调用指令 | `play(wager = 0.01 SOL)` |
| 读取时机 | 调用前后各 fetch 一次 PlayerState 账户 |

**断言：**
- `psAfter.rounds == psBefore.rounds + 1`（无论输赢，局数必须 +1）
- 赢：`psAfter.wins == psBefore.wins + 1`
- 输：`psAfter.wins == psBefore.wins`（不变）

---

#### TC-09 · Edge Case：拒绝重复初始化

```
rejects re-initialization of an existing config (Edge Case: double init)
```

| 项 | 值 |
|----|----|
| 调用指令 | `initialize(bankroll = 1 SOL)`（Config 账户已存在） |
| 期望行为 | 交易失败 |

**断言：**
- 抛出任意错误（Anchor 的 `init` 约束会检查账户是否已存在，已存在则直接拒绝，无需程序自定义错误码）

---

#### 测试覆盖矩阵

| 测试编号 | 类型 | 指令 | 覆盖点 |
|---------|------|------|--------|
| TC-01 | Happy Path | `initialize` | 账户创建、余额注入、authority 写入 |
| TC-02 | Happy Path | `play` | 下注流转、PlayerState 初始化与更新 |
| TC-03 | Edge Case | `play` | `ZeroWager` 错误码 |
| TC-04 | Edge Case | `play` | `InsufficientVaultFunds` 错误码 |
| TC-05 | Edge Case | `play` | `InsufficientPlayerFunds` 错误码 |
| TC-06 | State | `play` | `config.totalRounds` 全局计数 |
| TC-07 | State | `play` | Vault lamports 经济模型（赢减输增） |
| TC-08 | State | `play` | `playerState.wins` 仅胜时递增 |
| TC-09 | Edge Case | `initialize` | 重复初始化防护（断言 "already in use"） |
| TC-10 | Access | `withdraw` | 庄家提款成功,金库按额减少 |
| TC-11 | Access | `withdraw` | 非 authority 提款被拒（`Unauthorized`） |

> #6/#9 增强:TC-07 连玩多局,赢/输两条赔付分支大概率都被执行,且每局用金库余额变动做确定性断言;每个 play 用例打印实测 CU。随机数无法 mock,要 100% 强制覆盖赢的分支需把随机改成可注入(见「随机数」#1)。

---

## 从零部署（部署你自己的实例）

> 完整步骤见 [DEPLOY.md](./DEPLOY.md)，以下为速查版。

### Step 0：安装环境

```bash
# 一条命令装齐 Rust + Solana CLI + Anchor
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

# 重开终端后，锁定 Anchor 版本
avm install 0.31.1 && avm use 0.31.1

# 验证
anchor --version   # anchor-cli 0.31.1
solana --version   # solana-cli 4.0.3
node --version     # v18+
```

### Step 1：钱包与测试币

```bash
solana-keygen new                  # 生成 ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2 && solana airdrop 2 && solana airdrop 2
solana balance                     # 确认 >= 5 SOL
```

> 限流时改用网页水龙头：[https://faucet.solana.com](https://faucet.solana.com)

### Step 2：安装依赖

```bash
yarn install
```

### Step 3：同步 Program ID

```bash
# 生成本机专属密钥对，并自动同步 lib.rs / Anchor.toml 中的 Program ID
anchor keys sync
```

### Step 4：本地编译与测试

```bash
anchor build   # 编译 Rust 程序，生成 target/idl/ 和 target/types/
anchor test    # 全流程测试（11 个用例全绿则通过）
```

### Step 5：部署到 Devnet

```bash
anchor deploy --provider.cluster devnet
```

> 输出 `Program Id: <你的ID>` 表示成功。余额不足时回 Step 1 多领币。

### Step 6：初始化金库（仅需一次）

```bash
yarn init:vault 2   # 给 Vault PDA 注入 2 SOL 庄家本金
```

> 幂等操作：重复执行会检测到已初始化并跳过，不会重复扣款。

### Step 7：玩一局，拿 Tx Hash

```bash
yarn flip 0.1
```

输出里的 `solscan.io/tx/...?cluster=devnet` 链接即为可验证的交易记录。

---

## 资金流向

```
                    下注 wager（CPI：玩家签名）
  玩家钱包  ──────────────────────────────────►  Vault PDA (seeds=["vault"])
     ▲                                                   │
     │           赢：付 2 × wager                         │
     │    （CPI：程序用 vault seeds 签名 invoke_signed）    │
     └───────────────────────────────────────────────────┘
                    输：资金留在 Vault（归庄家）
```

| 结果 | 玩家净变化 | Vault 净变化 |
|------|-----------|-------------|
| 输   | −wager    | +wager      |
| 赢   | +wager    | −wager      |

---

## 架构设计

### PDA 设计

| PDA | Seeds | 用途 |
|-----|-------|------|
| Config | `["config"]` | 全局配置：authority、total_rounds、bump |
| Vault | `["vault"]` | 纯 SOL 账户，托管所有押注与本金 |
| PlayerState | `["player", player_pubkey]` | 每玩家独立状态：rounds、wins、last_won、last_wager |

PDA 没有私钥，转出资金唯一路径是程序内 `invoke_signed`，外部无法绕过程序直接动金库。

### 安全模型

- **PlayerState 租金**：由玩家自己支付（`payer = player`），`init_if_needed` 防止他人替代初始化。
- **Vault 转出**：`play` 中 `won == true` 分支与 `withdraw` 指令可触发，均由 Vault PDA 用 `seeds + bump` 经 `invoke_signed` 签名；外部无私钥,无法绕过程序动金库。
- **金库租金 floor（#2）**：`play` 的赔付与 `withdraw` 都校验"操作后金库余额仍 ≥ 租金豁免下限"（`Rent::minimum_balance(0)`），避免把金库打到豁免线以下,或打到 0 被系统销毁。
- **资金效率（#5）**：`play` 的金库校验为 `余额 ≥ wager + rent_min`（而非保守的 `2×wager`）。因为托管会先给金库 +1×wager,赢时净支出仅 1×wager,所以 1× + 租金即足够。
- **庄家提款（#3）**：`withdraw(amount)` 仅 `config.authority` 可调（`has_one = authority @ Unauthorized`），用于回收本金/取利润;同样受租金 floor 约束。
- **玩家余额检查（#4）**：`play` 里 `player.lamports() >= wager` 仅为 UX 友好提示;真正的兜底是 System Program CPI 转账在余额不足时自行失败回滚(该检查未计租金/手续费,非 load-bearing)。
- **数学溢出**：根 `Cargo.toml` 启用 `overflow-checks = true`，并用 `checked_mul/checked_add`，链上算术溢出直接 panic，不会静默截断。
- **重复初始化**：`initialize` 使用 Anchor `init` 约束，账户已存在时自动拒绝（System Program 报 "already in use"）。
- **随机数(已知局限)**：见下方「随机数」——伪随机可预测,且 same-tx 结算可被原子 free-roll,仅用于教学。

### 账户约束一览

```rust
// Initialize
config:  init, payer = authority, seeds = [b"config"], bump
vault:   mut,  seeds = [b"vault"],  bump（SystemAccount，不存数据）

// Play
config:       mut, seeds = [b"config"], bump = config.bump
vault:        mut, seeds = [b"vault"],  bump = config.vault_bump
player_state: init_if_needed, payer = player, seeds = [b"player", player.key()]

// Withdraw（庄家提款）
authority:    mut, Signer
config:       seeds = [b"config"], bump = config.bump, has_one = authority @ Unauthorized
vault:        mut, seeds = [b"vault"],  bump = config.vault_bump
```

---

## 技术说明

### 随机数

当前使用 `Clock(unix_timestamp + slot)` + 玩家公钥 + 局数做哈希取奇偶，**属于伪随机，可被出块者预测**，仅用于教学演示。生产环境应接入 [Switchboard VRF](https://switchboard.xyz/) 或其他可验证随机方案。

```rust
let mut buf = Vec::with_capacity(56);
buf.extend_from_slice(&clock.unix_timestamp.to_le_bytes());
buf.extend_from_slice(&clock.slot.to_le_bytes());
buf.extend_from_slice(player_key.as_ref());
buf.extend_from_slice(&rounds.to_le_bytes());
let won = hash(&buf).to_bytes()[0] % 2 == 0;  // 偶数 = 正面 = 赢
```

#### 更深一层的问题:同一笔交易内"出随机 + 结算"为什么根本不安全(原子 free-roll)

本 demo 把随机生成和资金结算放在**同一条 `play` 指令、同一笔交易**里。这带来一个比"随机数可预测"更根本的漏洞——**即使随机数完美无法预测,玩家依然能做到必不输**:

Solana 一笔交易里的多条指令**顺序执行、整体原子提交**,且前一条指令对账户的写入,后一条指令立即可读。攻击者用自己的程序写一条 `assert_win`(读 `player_state.last_won`,为 `false` 就 `panic`),然后打包成一笔交易 `[play(wager), assert_win]`:

- **输**:`assert_win` 中止 → **整笔回滚,连 `play` 里"玩家→金库"的托管转账一起撤销** → 玩家钱没少,等于没下注。
- **赢**:两条指令都成功 → 玩家拿走 `2 × wager`。

结果:庄家只会"落账"玩家赢的局,必亏。**注意这跟能否预测随机数无关,纯粹是原子可组合性(atomic composability)**——这是 Solana 链上赌博的经典漏洞。

**为什么本项目保留它**:挑战的验收标准对随机数只要求"**承认这是演示用的伪随机(acknowledge pseudo-randomness for demo)**",并不要求实现生产级安全随机。本 demo 仅用于 devnet 教学,不涉及真实资金,因此保留该结构、在此明确说明,而非引入额外复杂度。

**生产级正解(二选一)**:
1. **commit–reveal**:第一笔交易只下注、锁定资金、记录承诺;**在之后的区块**用玩家当时无法知道/无法操纵的未来值(如未来 slot hash)在第二条指令里结算。下注与结算跨交易,原子回滚便失效。
2. **VRF(如 [Switchboard](https://switchboard.xyz/))**:请求可验证随机数,在回调指令里结算。

> 一句话:`same-tx randomness + settlement` 永远不安全,安全的前提是"下注"和"结算"必须分处不同交易/区块。

### Compute Unit 消耗

`play` 指令包含：1 次 SHA-256、1–2 次 System Program CPI 转账、首次玩时的 `init_if_needed` 建账户。

实测约 **15,000–35,000 CU**，远低于 Solana 单指令 200,000 CU 上限。

```bash
# 查看具体消耗
anchor test 2>&1 | grep "compute units"

# 或通过交易签名查询
solana confirm -v <TxHash> --url devnet
```

### 成本对比：Solana vs Ethereum

> 参考价格：SOL ≈ $72.81，ETH ≈ $1,576.93，ETH gas ≈ 0.196 gwei

| 链 | 单次 flip 费用 | 约合 USD |
|----|---------------|----------|
| Solana | 0.000005 SOL（1 签名） | ~$0.0004 |
| Ethereum（0.196 gwei） | ~0.0000157 ETH | ~$0.025 |
| Ethereum（拥堵 10 gwei） | ~0.0008 ETH | ~$1.26 |

即使以太坊 gas 极低，Solana 单次成本仍便宜约 **60 倍**；拥堵时差距可达 **3000 倍以上**。

> 首次玩另有一次性 PlayerState 租金约 0.0011 SOL，关闭账户时可取回，不计入每局成本。

---

## EVM vs SVM 对比

| 维度 | Solidity (EVM) | Anchor (SVM) |
|------|----------------|--------------|
| 收款 | `payable` 函数，`msg.value` 自动到合约余额 | 无 payable；需显式 CPI 调用 System Program `transfer` |
| 状态存储 | 合约内 `mapping/storage`，与代码同体 | 代码（Program）与状态（Account）分离，状态存独立账户，需预分配空间并付租金 |
| 资金托管 | 合约地址即权限，`address(this).transfer` | 金库是 PDA，转出需 `seeds + bump` 做 `invoke_signed` |
| 随机数 | 无原生安全随机（常用 Chainlink VRF） | 同上；demo 用 Clock 哈希，生产用 Switchboard VRF |
| 账户声明 | 调用时无需声明读写哪些存储 | 必须在指令里显式列出所有读写账户 |

---

## 常见问题

**Q: 网页打开后「未检测到 Phantom」**  
A: 安装 [Phantom](https://phantom.app/) 浏览器插件后刷新页面。

**Q: 一下注就报 `InsufficientVaultFunds`**  
A: 金库余额不足以赔付 2× 押注。管理员需运行 `yarn init:vault 2` 补充本金，或减小押注金额。

**Q: `anchor test` 卡在启动验证节点**  
A: 端口被占。运行 `pkill -f solana-test-validator` 后重试。

**Q: `anchor deploy` 报 `Insufficient funds`**  
A: 部署需要 2–4 SOL 作为程序账户租金。运行 `solana airdrop 2` 多次补充余额。

**Q: `anchor keys sync` 显示 ID 不一致**  
A: 正常现象，该命令会自动将 `lib.rs` 和 `Anchor.toml` 中的 Program ID 更新为本机密钥对对应的地址。

---

## 安全警告

本项目仅用于教学演示，存在以下已知限制：

- 随机数可被出块者预测，**不适合 mainnet 真实资金场景**
- 无管理员提款指令（Vault 资金只能通过 play 流出）
- 无限注上限（仅受 Vault 余额约束）
