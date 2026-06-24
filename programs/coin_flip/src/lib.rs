use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;

// 占位 ID。运行 `anchor build` 后用 `anchor keys sync` 自动替换成真实 Program ID。
declare_id!("FWwP3TsYbpgdZtAnqmM3kEjvUZU1RnXuD1RMjvmXt4qV");

#[program]
pub mod coin_flip {
    use super::*;

    /// 指令 1：初始化全局配置(Config PDA),并给金库(Vault PDA)注入"庄家本金"。
    /// 金库必须有足够余额,才能在玩家赢时支付 2 倍奖金。
    pub fn initialize(ctx: Context<Initialize>, initial_bankroll: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.total_rounds = 0;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault;

        if initial_bankroll > 0 {
            // CPI 调用 System Program,把本金从 authority 转入 vault。
            // authority 是真实签名者,无需 PDA 签名。
            let cpi = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            );
            system_program::transfer(cpi, initial_bankroll)?;
        }

        msg!("Initialized. Vault bankroll = {} lamports", initial_bankroll);
        Ok(())
    }

    /// 指令 2：玩一局。
    /// 1) 把 wager 从玩家托管进 vault(escrow)
    /// 2) 用 Clock 生成伪随机结果(仅用于演示,非安全随机)
    /// 3) 赢 -> 从 vault 付 2*wager 回玩家;输 -> 资金留在 vault
    pub fn play(ctx: Context<Play>, wager: u64) -> Result<()> {
        require!(wager > 0, FlipError::ZeroWager);

        // 提前克隆出 AccountInfo,避免后面同时可变借用 ctx.accounts 触发借用检查器报错。
        let player_ai = ctx.accounts.player.to_account_info();
        let vault_ai = ctx.accounts.vault.to_account_info();
        let system_ai = ctx.accounts.system_program.to_account_info();
        let player_key = ctx.accounts.player.key();

        // 安全检查 1（#4：仅 UX 友好提示，非硬性不变量）：玩家大致买得起。
        // 说明：即便去掉这行，后面"玩家 -> 金库"的 System Program CPI 转账也会在
        // 余额不足时自行失败回滚；且此处未计入 init_if_needed 扣的 PlayerState 租金
        // 与交易手续费，所以它只是给个更清晰的错误，不是 load-bearing 的校验。
        require!(
            player_ai.lamports() >= wager,
            FlipError::InsufficientPlayerFunds
        );

        let payout = wager.checked_mul(2).ok_or(FlipError::MathOverflow)?;

        // 安全检查 2（#2 租金豁免 + #5 资金效率，一并修复）：
        // 托管后金库余额 = 当前余额 + wager；若赢则赔 payout(=2*wager)，
        // 净减少 1*wager。要求"赔付后金库仍保持租金豁免下限"，
        // 即：当前余额 >= wager + rent_min（而不是保守的 2*wager）。
        // 这样既不会把金库打到豁免线以下/打到 0 被销毁，又只需 1x 敞口资金。
        let rent_min = Rent::get()?.minimum_balance(0); // 0 数据 SystemAccount 的租金豁免下限
        let required_vault = wager
            .checked_add(rent_min)
            .ok_or(FlipError::MathOverflow)?;
        require!(
            vault_ai.lamports() >= required_vault,
            FlipError::InsufficientVaultFunds
        );

        // 1) 托管:玩家 -> 金库(玩家是真实签名者)
        system_program::transfer(
            CpiContext::new(
                system_ai.clone(),
                system_program::Transfer {
                    from: player_ai.clone(),
                    to: vault_ai.clone(),
                },
            ),
            wager,
        )?;

        // 2) 伪随机:把多个链上变量拼接后做哈希,取首字节奇偶。
        //    ⚠️ 这是可被验证者/出块者预测的伪随机,生产环境请用 Switchboard VRF 等。
        let clock = Clock::get()?;
        let rounds = ctx.accounts.player_state.rounds;
        let mut buf = Vec::with_capacity(56);
        buf.extend_from_slice(&clock.unix_timestamp.to_le_bytes());
        buf.extend_from_slice(&clock.slot.to_le_bytes());
        buf.extend_from_slice(player_key.as_ref());
        buf.extend_from_slice(&rounds.to_le_bytes());
        let won = hash(&buf).to_bytes()[0] % 2 == 0; // 偶数 = 正面 = 赢

        // 3) 结算:赢则由 vault(PDA)签名把 2*wager 转回玩家。
        if won {
            let vault_bump = ctx.accounts.config.vault_bump;
            let bump = [vault_bump];
            let seeds: &[&[u8]] = &[b"vault".as_ref(), &bump];
            let signer: &[&[&[u8]]] = &[seeds];

            system_program::transfer(
                CpiContext::new_with_signer(
                    system_ai.clone(),
                    system_program::Transfer {
                        from: vault_ai.clone(),
                        to: player_ai.clone(),
                    },
                    signer,
                ),
                payout,
            )?;
        }

        // 4) 更新玩家状态 + 全局计数,并发出事件供客户端读取。
        let ps = &mut ctx.accounts.player_state;
        ps.player = player_key;
        ps.rounds = ps.rounds.checked_add(1).ok_or(FlipError::MathOverflow)?;
        if won {
            ps.wins = ps.wins.checked_add(1).ok_or(FlipError::MathOverflow)?;
        }
        ps.last_won = won;
        ps.last_wager = wager;
        ps.bump = ctx.bumps.player_state;

        let cfg = &mut ctx.accounts.config;
        cfg.total_rounds = cfg.total_rounds.checked_add(1).ok_or(FlipError::MathOverflow)?;

        emit!(FlipResult {
            player: player_key,
            wager,
            won,
            round: ps.rounds,
        });
        msg!("Flip result: {}", if won { "WIN (Heads)" } else { "LOSE (Tails)" });
        Ok(())
    }

    /// 指令 3（#3：庄家提款路径）：authority 把金库里的 SOL 取走（回收本金/取利润）。
    /// 权限由 Withdraw 里的 `has_one = authority` 约束死：只有 config.authority 能调。
    /// 同样保留租金 floor：取款后金库必须仍保持租金豁免,避免账户被销毁。
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, FlipError::ZeroAmount);

        let vault_ai = ctx.accounts.vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(0);
        let remaining = vault_ai
            .lamports()
            .checked_sub(amount)
            .ok_or(FlipError::InsufficientVaultFunds)?;
        require!(remaining >= rent_min, FlipError::InsufficientVaultFunds);

        // 用 Vault PDA 的 seeds 签名,把 amount 转给 authority。
        let vault_bump = ctx.accounts.config.vault_bump;
        let bump = [vault_bump];
        let seeds: &[&[u8]] = &[b"vault".as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: vault_ai.clone(),
                    to: ctx.accounts.authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        msg!("Authority withdrew {} lamports from vault", amount);
        Ok(())
    }
}

// ---------- Accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    /// 金库:一个由程序派生(PDA)、但归属 System Program 的"纯 SOL"账户。
    /// 不存数据,只存 lamports。转出时由程序用 seeds 签名。
    #[account(
        mut,
        seeds = [b"vault"],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump = config.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    /// 每个玩家一个状态账户。seeds 包含 player.key(),天然隔离 + 防重复初始化攻击。
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// 必须是 config 里记录的 authority(庄家),否则 has_one 校验失败。
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ FlipError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump = config.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ---------- State ----------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub total_rounds: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub player: Pubkey,
    pub rounds: u64,
    pub wins: u64,
    pub last_wager: u64,
    pub last_won: bool,
    pub bump: u8,
}

// ---------- Event & Errors ----------

#[event]
pub struct FlipResult {
    pub player: Pubkey,
    pub wager: u64,
    pub won: bool,
    pub round: u64,
}

#[error_code]
pub enum FlipError {
    #[msg("Wager must be greater than zero")]
    ZeroWager,
    #[msg("Player has insufficient funds for this wager")]
    InsufficientPlayerFunds,
    #[msg("Vault has insufficient funds to cover a potential 2x payout")]
    InsufficientVaultFunds,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Withdraw amount must be greater than zero")]
    ZeroAmount,
    #[msg("Only the configured authority can perform this action")]
    Unauthorized,
}
