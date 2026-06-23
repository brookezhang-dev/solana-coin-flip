# 执行手册:Solana Coin Flip 从零到 Devnet 跑通

> 工程脚手架已经搭好(标准 Anchor 0.31.1 结构),`lib.rs` / 测试 / 客户端 / `client/init.ts` 都已就位,
> `init-if-needed` feature、Program ID 三处一致性也已配好。
> **所以不要再跑 `anchor init`**,按下面步骤直接执行即可。
>
> 标注 💻 的步骤在**你自己的电脑**上跑;每一步都给了「预期输出」,对不上就看「常见报错」。

---

## 当前工程结构(确认一下)

```
solana-coin-flip/
├── Anchor.toml
├── Cargo.toml
├── package.json
├── tsconfig.json
├── programs/coin_flip/
│   ├── Cargo.toml          # 已开 init-if-needed
│   └── src/lib.rs          # 合约
├── tests/coin_flip.test.ts # 本地测试
├── client/
│   ├── init.ts             # devnet 初始化金库(新增)
│   └── flip.ts             # devnet 玩一局
└── migrations/deploy.ts
```

---

## Step 0 — 装环境 💻

一条命令装齐 Rust + Solana CLI + Anchor + Node:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

**装完关掉终端、重新开一个**(让 PATH 生效),然后锁定 Anchor 版本并验证:

```bash
avm install 0.31.1 && avm use 0.31.1
anchor --version && solana --version && node --version
```

**预期输出**(版本号大致如下):

```
anchor-cli 0.31.1
solana-cli 2.x.x (或 1.18.x)
v20.x.x
```

**常见报错**

- `command not found: anchor` → PATH 没生效。重开终端,或手动 `source ~/.profile`(zsh 用 `source ~/.zshrc`)。
- `avm: command not found` → 上面的 install 脚本没装上 avm,手动装:`cargo install --git https://github.com/coral-xyz/anchor avm --force`,再 `avm install 0.31.1 && avm use 0.31.1`。

---

## Step 1 — 建钱包 + 领测试币 💻

```bash
solana-keygen new                  # 生成 ~/.config/solana/id.json,记好助记词
solana config set --url devnet
solana balance
```

领币(devnet 单次上限 2 SOL,**部署程序要花 2~4 SOL,所以多领几次**):

```bash
solana airdrop 2
solana airdrop 2
solana balance                     # 确认 >= 5 SOL 再往下走
```

**预期输出**:`solana balance` 显示 `5 SOL`(或更多)。

**常见报错**

- airdrop 报 `rate limit` / 领不到 → 换网页水龙头 https://faucet.solana.com ,粘贴 `solana address` 的地址领。
- 余额不够会卡在 Step 5 的部署,务必先攒够。

---

## Step 2 — 安装项目依赖 💻

进入工程目录(替换成你的实际路径),拉 npm 依赖:

```bash
cd solana-coin-flip
yarn install          # 或 npm install
```

`ts-node`、`ts-mocha`、`@coral-xyz/anchor`、`@solana/web3.js` 都已在 `package.json` 里,这一步会一并装好。

**预期输出**:生成 `node_modules/` 和 `yarn.lock`,无 error。

---

## Step 3 — 同步 Program ID 💻

`lib.rs` 里现在是占位 ID。这条命令会生成你本机专属的程序密钥对,并自动改写
`lib.rs` 的 `declare_id!` 和 `Anchor.toml`,让三处 ID 一致:

```bash
anchor keys sync
```

**预期输出**:类似 `Found incorrect program id ... updated to <你的真实ID>`,或 `All program id declarations are synced.`

**核对一下**(三处应一致):

```bash
anchor keys list
grep declare_id programs/coin_flip/src/lib.rs
```

---

## Step 4 — 本地编译 + 测试 💻

```bash
anchor build          # 第一次会下载/编译依赖,慢,耐心等
anchor test           # 自动起本地验证器 → 部署 → 跑 tests/,看到全绿就过
```

`anchor build` 之后才会生成 `target/idl/coin_flip.json` 和 `target/types/coin_flip.ts`,
此时 IDE 里之前标红的 `../target/...` 导入就正常了。

**预期输出**(`anchor test` 末尾):

```
  coin_flip
    ✔ initializes and funds the vault (Happy Path: setup)
    ✔ plays a round and updates player state (Happy Path: bet -> settle)
    ✔ rejects a zero wager (Edge Case: bet 0)
    ✔ rejects a wager the vault cannot cover (Edge Case: bet too big)

  4 passing
```

> 注:第 2 个用例是真随机抛硬币,只断言"局数+1、下注额正确",不断言输赢,所以每次跑结果可能不同,正常。

**常见报错**

- `error: package ... requires rustc 1.xx` / 工具链版本错 → `rustup update`,再 `anchor build`。
- `init_if_needed` 相关报错 → 确认 `programs/coin_flip/Cargo.toml` 里是
  `anchor-lang = { version = "0.31.1", features = ["init-if-needed"] }`(已配好,一般不会报)。
- 卡在 `Deploying...` 很久 → 本地验证器端口被占,`pkill -f solana-test-validator` 后重试。

---

## Step 5 — 部署到 Devnet 💻

```bash
anchor deploy --provider.cluster devnet
```

**预期输出**:`Program Id: <你的ID>` + `Deploy success`。

**常见报错**

- `Insufficient funds` → 余额不够付租金,回 Step 1 多领币。
- `Error: Account ... not found` / blockhash 过期 → 网络抖动,直接重跑这条命令(部署可断点续传)。

> deploy 之后 `target/idl/coin_flip.json` 里的 `address` 就是这个已部署的 Program ID,
> `init.ts` / `flip.ts` 都靠它找到链上程序。

---

## Step 6 — 初始化金库(devnet 必做一次)💻

`play` 要求金库先有钱才能赔付。本地测试的 initialize **不会**作用到 devnet,
所以这里要在 devnet 上单独跑一次,给金库注入 2 SOL 庄家本金:

```bash
yarn init:vault 2
# 等价于:RPC_URL=https://api.devnet.solana.com ts-node client/init.ts 2
```

**预期输出**:

```
Program:   <ID>
Authority: <你的钱包地址>
Vault PDA: <金库地址>
正在初始化,注入金库本金:2 SOL ...
Tx:            https://solscan.io/tx/...?cluster=devnet
Vault balance: 2.0000 SOL
✅ 初始化完成,现在可以跑 client/flip.ts 玩一局了。
```

> 这个脚本是幂等的:再跑一次会检测到 Config 已存在,直接跳过(不会报错也不会重复扣钱)。

---

## Step 7 — 玩一局,拿 Tx Hash ✅

```bash
yarn flip 0.1
# 等价于:RPC_URL=https://api.devnet.solana.com ts-node client/flip.ts 0.1
```

**预期输出**:

```
Player:          <你的地址>
Balance before:  4.xxxx SOL
Wager:           0.1 SOL
Tx:              https://solscan.io/tx/<HASH>?cluster=devnet
-----------------------------------------
Result:          WIN 🎉 (Heads)  /  LOSE 😞 (Tails)
Rounds / Wins:   1 / 0
Balance after:   4.xxxx SOL
```

那行 `https://solscan.io/tx/...?cluster=devnet` 就是验收要的 **Tx Hash**,直接贴进交付材料。

**常见报错**

- `InsufficientVaultFunds` → 金库余额 < 2×下注额。要么把下注调小,要么回 Step 6 给金库多注资。
- `AccountNotInitialized` (config/vault) → Step 6 没跑或跑在了别的网络。确认 `RPC_URL` 是 devnet。

---

## 一页速查(全绿流程)

```bash
# 0. 装环境(重开终端后)
avm install 0.31.1 && avm use 0.31.1

# 1. 钱包 + 币
solana-keygen new
solana config set --url devnet
solana airdrop 2 && solana airdrop 2

# 2-4. 依赖 → 同步ID → 本地测试
yarn install
anchor keys sync
anchor build && anchor test

# 5-7. 部署 → 注资 → 玩
anchor deploy --provider.cluster devnet
yarn init:vault 2
yarn flip 0.1
```

> 任何一步报错,把**完整报错**贴回来——尤其 `anchor build` 的工具链/版本错,这块最容易卡。
