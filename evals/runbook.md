# 操作手册：怎么跑一次评测

## 两个样本，两套标准答案

| 样本 | 测什么 | 标准答案 | 跑哪几轮 |
|---|---|---|---|
| `evals/fixtures/tiny-shop` | 契约、文档、错误路径、并发、兼容性——通用面 | `ground-truth.md`（G1–G25） | A + B + C |
| `evals/fixtures/rule-engine` | **算法/复杂度**与**架构/设计语义**——反驳与规模扫描 | `ground-truth-rule-engine.md`（R1–R10 里的 9 条 + C1） | B + C |

**为什么分两个样本**：tiny-shop 是 184 行的结算模块，里面**没有指数级回溯，也没有分裂成两条路径的动作**——它测不出新能力。两个样本分开跑，分数分开记，才能同时回答「旧的没退化」和「新的生效了」。

## 准备

**第 0 步：先跑 lint。** 契约自身矛盾时，评测分数没有意义——测的是哪一份契约都不确定。

```bash
node tools/lint-skill.mjs .        # 必须 exit 0
node tools/lint-consistency.mjs .  # 必须 exit 0
```

```bash
# 把样本复制到临时目录，别在仓库里改
# 每个轮次一份独立副本——轮次之间不共用目录（见「常见坑」）
cp -r evals/fixtures/tiny-shop /tmp/dcr-eval-A
cp -r evals/fixtures/tiny-shop /tmp/dcr-eval-B
cp -r evals/fixtures/tiny-shop /tmp/dcr-eval-C
cp -r evals/fixtures/rule-engine /tmp/dcr-eval-rule-B
cp -r evals/fixtures/rule-engine /tmp/dcr-eval-rule-C
```

Windows PowerShell：

```powershell
Copy-Item -Recurse evals\fixtures\tiny-shop $env:TEMP\dcr-eval-A
Copy-Item -Recurse evals\fixtures\tiny-shop $env:TEMP\dcr-eval-B
Copy-Item -Recurse evals\fixtures\tiny-shop $env:TEMP\dcr-eval-C
Copy-Item -Recurse evals\fixtures\rule-engine $env:TEMP\dcr-eval-rule-B
Copy-Item -Recurse evals\fixtures\rule-engine $env:TEMP\dcr-eval-rule-C
```

> **为什么每个轮次一份副本**：轮次之间共用同一个目录，后一轮会读到磁盘上前一轮留下的结论，那一轮作废。
> 这条与「常见坑」里的并发纪律是同一件事的两面——**同一轮次不要并发跑同一份样本的多个副本，
> 不同轮次也不要共用一个目录**。

> **不要把 `ground-truth.md` / `ground-truth-rule-engine.md` / `rubric.md` 放进被审目录**——被测模型看到标准答案，这次评测就废了。
>
> **样本副本要做中性化**：复制到隔离目录后，用仓内的 `README.neutral.md` **覆盖** `README.md`
> （内容一样的话就不用换），并把 `README.neutral.md` 本身删掉——留两份 README 会让被测模型不知道读哪份。
> 其余文件**逐字节**复制，SHA256 必须与仓库一致。
>
> **中性化的判据只有一条：保留「是什么」（约定、规模上限、结构），删掉「所以会怎样」（后果描述、缺陷披露）。**
> 按这条判据，两个样本要删的分别是：
> - tiny-shop：「刻意植入缺陷」这句披露；「否则同一个金额在两条路径上会算出不同的分数」（后果，正是 G6 的答案）；
>   「不构成对外公开契约」（这是从 `internal/` 推出来的**结论**，模型该自己推）；「见 `evals/runbook.md`」这段用法。
> - rule-engine：「刻意植入缺陷」这句披露；「不构成对外公开契约」；「见 `evals/runbook.md`」这段用法。
> - **rule-engine 的规模上限（200 商品行 / 200 条规则 / 依赖链最深 50 层 / 一条规则最多 12 个 SKU）必须保留**——
>   R1 与 R4 的成立点就是「在 README 写的上限下会怎样」，删了它这个样本就测不出规模扫描了。
>
> **副作用**：报告里引用 README 的行号会比仓库 fixture 差 1–2 行。
> 标准答案只引用 `.go` 文件行号，不受影响；评分时**不要**因为 README 行号差一位就扣「表达质量」。
>
> **被测上下文要能读到 skill 本体**：skill 装好后，约束里要写清「skill 副本在哪个路径」，
> 而不是禁止它读安装目录——它读不到就会去磁盘上乱找，实测捡到过一份过期旧副本，
> 导致那一轮按旧口径判案、整轮作废。要禁的是**仓库里的 `evals/` 目录**（那里才有标准答案）。

### D 轮：带 git 基线的副本（快模式轮）

D 轮要的是**一个真实的基线**，不是「假装有基线」。基线提交与 HEAD 提交必须落在不同的文件上，
否则「本次引入 vs 既有」就分不出来——那样 D 轮验的就不是快模式了。

基线提交的构成：**`go.mod` + `README.md` + `internal/checkout/`（含测试）**；
HEAD 提交**新增 `internal/refund/refund.go`**。归属表见 `ground-truth.md` 的「D 轮归属表」。

Windows PowerShell：

```powershell
$env:TEMP
Copy-Item -Recurse evals\fixtures\tiny-shop $env:TEMP\dcr-eval-d
Copy-Item evals\fixtures\tiny-shop\README.neutral.md $env:TEMP\dcr-eval-d\README.md -Force
Remove-Item $env:TEMP\dcr-eval-d\README.neutral.md

cd $env:TEMP\dcr-eval-d
git init
git add go.mod README.md internal\checkout
git commit -m "baseline: 结算流程"
git add internal\refund
git commit -m "feat: 新增退款流程"
```

Linux / macOS：

```bash
cp -r evals/fixtures/tiny-shop /tmp/dcr-eval-d
cp evals/fixtures/tiny-shop/README.neutral.md /tmp/dcr-eval-d/README.md
rm /tmp/dcr-eval-d/README.neutral.md
cd /tmp/dcr-eval-d
git init
git add go.mod README.md internal/checkout
git commit -m "baseline: 结算流程"
git add internal/refund
git commit -m "feat: 新增退款流程"
```

> **没配 `user.email` 会提交失败**：用 `git -c user.email=eval@example.com -c user.name=eval commit` 代替 `git commit`。
> **默认分支名可能是 `master` 也可能是 `main`**——不影响评测，但记下来（报告里的基线名要写实际那个）。
> **`git init` 后不要 `git add -A`**：那会把 `internal/refund` 一起塞进基线提交，基线就不成基线了。

## 跑四种问法

同一份样本，用四种问法各跑一轮。这一步同时验证**路由**和**两档模式**：

| 轮次 | 问法 | 期望 |
|---|---|---|
| A | `审一下 /tmp/dcr-eval-A 这个 PR 有没有回归，能不能合` | 样本**没有 git 历史** → 按契约走**无基线全量体检**：范围行写「（无基线，全量体检）」、标签第三段 `[现状]`、结论档读作「本路径没有/有必须改的问题」 |
| B | `用 deep-code-review 按七维审 /tmp/dcr-eval-B` | 全量模式：七维 + 类型 playbook + 七段式 + 覆盖表 |
| C | `给 /tmp/dcr-eval-C/internal 这个模块做个体检，看看设计、契约、重复、过度设计` | 全量模式，且应命中 G2/G3/G6/G9 这些「设计类」条目 |
| D | `审一下 /tmp/dcr-eval-d 这个 PR 有没有回归，能不能合`（样本**带 git 基线**） | 走**快模式**：紧凑列表（每条 = 标题 + 3 行）、只报本次引入的问题、标签第三段 `[本次引入]`；**不应**输出七段式骨架 |

> **路径带轮次后缀**：每个轮次读自己的副本（复制步骤见上面「准备」）。
> 轮次之间共用一个目录时，后一轮会读到前一轮留在磁盘上的结论，那一轮作废。

**A 轮不是快模式轮。** 快模式判的是「本次改动有没有坏」，没有基线就没有「本次改动」可言——契约规定快模式必须有基线，而样本是裸目录，所以它走**无基线全量体检**，输出七段式是**正确行为**，不是「快模式没生效」。首轮评测的验收条件写的是「A 轮应输出紧凑列表」，那一条与实际行为对不上，已作废。

**要验快模式，用 D 轮**：给样本建一个真实基线（`git init` → 空树基线提交 → 全部文件作为「本次改动」再提交一次），问法照 A 轮。D 轮验的是**快模式本身**——合并判定必须由这个 skill 直接给出，形态是紧凑列表 + 一句结论，不依赖任何其他工具；七段式骨架出现就是快模式没生效。

**A 轮与 D 轮的差别就是有没有基线**，这也正是契约里「快模式必须有基线」那条规则的验收点。

### rule-engine 样本只跑 B + C

新能力（**反驳**与**规模扫描**）只在全量模式跑——它们找的是设计与算法层面的问题，不是「这次改动有没有坏」。所以 rule-engine 样本跑两轮：

| 轮次 | 问法 | 期望 |
|---|---|---|
| B | `用 deep-code-review 按七维审 /tmp/dcr-eval-rule-B` | 全量模式：七维 + **反驳** + **规模扫描** + 七段式 + 覆盖表 |
| C | `给 /tmp/dcr-eval-rule-C/internal/promo 这个模块做个体检，看看设计、契约、重复、过度设计` | 全量模式，且应命中 R1/R3/R4/R5/R6 这些「规模 + 语义」条目 |

**规模类条目在报告里的形态**：给「规模 N → 开销」的关系与实测数字，不是「输入 → 错误结果」那种触发路径。报告没给数字的，按 `ground-truth-rule-engine.md` 的计分要点最多记 0.5。

**A 轮不跑 rule-engine**：快模式契约里没有这两遍，跑它只能验出「快模式没乱报」，收益低。

## 记录

把每轮的输出原样存下来（不要摘要），再对照 `ground-truth.md` 打分，
按 `rubric.md` 的格式写出评分表。

## 常见坑

- **别把 ground truth 喂给模型**。哪怕是「提示一下重点看哪里」也会毁掉结果。
- **一轮不够**。同一 skill 两轮之间有波动是已知的（README 的「评测」一节就写了）。
  想看稳定性就跑 3 轮，取中位数。
- **样本都很小**。tiny-shop 184 行、rule-engine 377 行，都读得完。漏报不能用「范围太大没读完」解释——
  如果模型说「未覆盖」，那是它自己的选择，要记下来。
- **别把历次评测的原始输出放在样本目录旁边**。那些原始输出本身就是「答案」——
  上一轮的评审全文躺在样本目录旁边时，有一轮直接把上一轮结论读进去了，那一轮作废重跑。
- **原始输出目录与样本目录不要有父子关系**，也不要放在同一个父目录下——
  被测上下文有可能往父目录翻，命中任何一份历史评审都会污染这一轮。
- **两个样本的隔离目录也要分开**，理由同上：rule-engine 的标准答案和 tiny-shop 的不能互相可见。
- **同一轮次不要并发跑同一份样本的多个副本**。每个轮次用独立目录（`$env:TEMP\dcr-eval-{A,B,C,D}`、rule-engine 用 `dcr-eval-rule-{B,C}`）——
  并发跑同一个样本时，后一轮会读到磁盘上前一轮留下的结论，那一轮作废。
  **不同轮次之间也不共用一个目录**——准备步骤里的复制必须带轮次后缀。
- **skill 全程冻结**。开跑前记一次 skill 安装目录的提交号，收轮再核对一次；不一致这轮作废。
  评测期间改过任何 `SKILL.md` / `references/` 文件，整轮分数就失去意义——测的是移动靶。
  这两类污染历史上都真发生过（见 `baseline.md` 的 v4 轮「作废原因」）。

**开跑前的三条机器检查**（三条都过才起跑）：

```powershell
# ① 样本副本里只应有一份 README（留两份，被测模型不知道读哪份）
Get-ChildItem $env:TEMP\dcr-eval-<轮次> -Filter 'README*'
# ② 样本目录的父目录里不能有上一轮的评审全文
Get-ChildItem (Split-Path $env:TEMP\dcr-eval-<轮次>) -Filter 'round-*.md'
# ③ skill 冻结：开跑记一次，收轮再比一次，两次必须相同
git -C <skill 安装目录> rev-parse HEAD
```

①的输出应只有 `README.md` 一个文件，②的输出应为空。
- **不是每次都要跑全四种问法**。改 skill 正文时跑 B+C；
  只改 description 时重点跑 D（路由）；改输出契约时重点看 C（结构）。
  涉及新能力（反驳 / 规模扫描）的改动，**必须**跑 rule-engine 的 B+C——tiny-shop 测不出它。

## 什么时候必须跑

- 改了 `SKILL.md` 或 `references/` 下任一文件 → **必须跑评测**（闸门、成立条件、playbook 覆盖范围、标签形态、输出骨架任一处变动都会改结论行或改误报率）。
- 改了 `tools/` 下的 lint → **不必跑评测**，但**必须跑 lint**。lint 不改变被测行为，它只决定「契约自相矛盾时能不能被拦住」——把某个检查放松了，评测分数不会动，但守门没了。所以这条是「改 lint 必跑 lint」，不是「改 lint 必跑评测」。
- 只改了 README / 徽章 / CI → **不必跑评测**；但改了 README 里的**七维速查表** → **必须跑 lint**（它与 `SKILL.md` 那份逐行比对，分叉了 lint 才拦得住）。

**改动文件 → 必须跑哪几轮**（只跑 B+C 会漏掉某些改动的验收点）：

| 改了什么 | 必须跑 |
|---|---|
| `SKILL.md` 正文（判据、流程、输出契约） | tiny-shop B + C，rule-engine B + C |
| `references/dimensions.md`（七维细则、成立条件） | tiny-shop B + C，rule-engine B + C |
| `references/playbooks.md`（载体判据、必查项、覆盖声明） | tiny-shop B + C，rule-engine B + C |
| `references/verification.md`（闸门表、证据阶梯） | tiny-shop B + C，rule-engine B + C |
| `references/regression-review.md`（快模式形态、计数格式、固定行） | tiny-shop **D**——只跑 B+C 测不到快模式 |
| `references/output-template.md`（骨架与措辞） | tiny-shop B + C + **D** |
| `SKILL.md` 的 frontmatter `description` | tiny-shop **D**（验路由） |
| `tools/` | 跑 lint 即可，不必跑评测 |
| `evals/` 下的 GT 与 rubric | **必须全跑**（改了口径，旧分数全部作废） |
| `README.md`（含七维速查表） | 跑 lint 即可（速查表与 `SKILL.md` 那份逐行比对），不必跑评测 |
| `evals/fixtures/**`（样本源码） | **必须全跑并同步更新 GT**——GT 的触发路径写的就是 fixture 的行号，样本一改，既有 GT 与样本就脱节 |
| `evals/runbook.md`（评测流程与映射表） | **必须全跑**（流程变了，之前的轮次不是按新流程跑的） |
| `evals/README.md`（评测目录说明） | **必须全跑**（与 runbook 同源，口径说明变了就不能沿用旧分数） |

**放行条件**：一轮评测算不算通过，按 `rubric.md` 的「判定」一节判——
契约分 6 项全得 1 且覆盖表 15 行无缺行、命中 ≥ 有效分母的 70%、误报 0 条。三条全过才算这一轮有效。

**基线有效性自查**：改完契约但还没重跑 → **当前基线失效**。
`evals/baseline.md` 顶部的「基线状态」一节写着当前基线对应哪个提交；对不上就不能拿它比。

## 归档

把每轮的输出原样存下来（不要摘要），再对照对应的标准答案打分
（tiny-shop → `ground-truth.md`，rule-engine → `ground-truth-rule-engine.md`），
按 `rubric.md` 的格式写出评分表。

**存哪**：

- 原始输出（每轮一份全文）**不入版本控制**，放**仓外**。用绝对路径，别用仓库内的相对路径——
  仓内的 `scratchpads\` 一次 `git add -A` 就会把上一轮评审全文提交进要发布的仓库，
  而评审全文本身就是答案（本手册上面那条「别把历次原始输出放在样本目录旁边」说的就是同一件事）。
  - Windows 示例：`%LOCALAPPDATA%\Temp-dcr-archive\round-{A,B,C,D}-vN.md`
  - Linux / macOS 示例：`/tmp/dcr-eval-archive/round-{A,B,C,D}-vN.md`
- 评分表入版本控制，追加到 `evals/baseline.md`；跑完一版就追加一节，**不要覆盖旧记录**——旧记录是「当时按当时的标准答案跑出来的结果」，属历史事实。
- 改了 `ground-truth.md` / `ground-truth-rule-engine.md` 或 `rubric.md` 之后，旧分数与新分数**不可比**，必须在记录里写明，并重跑一轮拿新口径的基线。

**贴到 issue**：如果这次评测是为了验证某个改动，把评分表贴到那个改动的 issue 或 PR 评论里。这样每个 PR 都能看到「这个改动让审查变好还是变坏」。
