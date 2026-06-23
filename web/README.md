# 网页前端 · 发个链接就能玩

`index.html` 是一个**单文件静态网页**:用 CDN 加载 `@solana/web3.js`,连 Phantom 钱包,手动构造 `play` 指令调用你部署在 devnet 上的程序。没有打包构建步骤,任何静态托管都能直接挂。

## 前提

1. 程序已经部署到 devnet(`anchor deploy --provider.cluster devnet`)。
2. 已经初始化金库(`yarn init:vault 2`),否则别人一玩就报 `InsufficientVaultFunds`。
3. **确认 `index.html` 里的 `PROGRAM_ID` 是你自己的程序 ID**(当前已填 `FWwP3Ts...`,换程序记得改这一行)。

## 本地先试

```bash
cd web
python3 -m http.server 5173
# 浏览器打开 http://localhost:5173
```

> 不能直接双击用 `file://` 打开——ES module + CDN 在 `file://` 下会被浏览器拦。必须用本地 http 服务(上面这条)。

玩家侧操作:点「连接 Phantom」→ 在 Phantom 里把网络切到 **Devnet** → 领点 devnet 测试币 → 输入押注 → 点「抛硬币」→ 在 Phantom 里签名。

## 上线方式一:Vercel(最快,推荐)

```bash
npm i -g vercel        # 装一次
cd web
vercel                 # 首次会让你登录 + 起项目名,一路回车
vercel --prod          # 正式发布,拿到 https://xxx.vercel.app
```

把 `vercel --prod` 输出的链接发出去就行。或者更省事:登录 https://vercel.com → New Project → 直接把 `web/` 文件夹拖进去。

## 上线方式二:GitHub Pages(纯免费、绑 Git 仓库)

1. 把整个工程推到 GitHub。
2. 仓库 **Settings → Pages**。
3. Source 选 `Deploy from a branch`,Branch 选 `main`,目录选 `/ (root)`——但因为页面在 `web/` 子目录,有两种做法:
   - **简单做法**:把 `web/index.html` 复制一份到仓库根目录,Pages 选 root。
   - **保持目录**:把 Pages 的目录设为 `/docs`,并把 `web/` 改名为 `docs/`。
4. 等 1~2 分钟,Pages 会给一个 `https://<用户名>.github.io/<仓库名>/` 链接。

## 玩家需要什么

- 装了 **Phantom** 浏览器插件;
- Phantom 网络切到 **Devnet**;
- 钱包里有一点 devnet SOL(押注 + 手续费),没有就去 https://faucet.solana.com 领。

## 常见问题

- **页面打不开/控制台报 module 错** → 你是用 `file://` 双击打开的。改用 `python3 -m http.server` 或线上链接。
- **「未检测到 Phantom」** → 没装插件,或用的浏览器不支持。装 Phantom 后刷新。
- **一玩就 `InsufficientVaultFunds`** → 金库没钱或押注太大。庄家先 `yarn init:vault 2` 给金库注资,玩家把押注调小。
- **公共 RPC 偶发限流/超时** → 重试即可;要稳定可在 `index.html` 把 `RPC` 换成自己的 Helius/QuickNode devnet 节点。
- **换了程序但页面没反应** → 检查 `index.html` 顶部 `PROGRAM_ID` 是否更新成新部署的 ID。

## 安全提示(教学项目须知)

随机数用的是 `Clock + slot` 伪随机,**出块者可预测**,只能玩 devnet 假币。绝对不要把这套逻辑拿去 mainnet 收真钱。
