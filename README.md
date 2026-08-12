# Issue Fix Agent

一个从 Issue 出发，在受控代码仓库中自主完成“理解、修改、验证、汇报”的轻量级 Code Agent。

这个项目不是另一个通用 AI IDE，也不试图复刻 Claude Code。它关注一个更窄、可评测、适合持续迭代的问题：

> 给定一个描述清楚的 Issue，Agent 能否产出一份通过自动化检查、方便人工审查的候选修复？

项目目前处于 Milestone 0。工程骨架与最小 Agent Loop 已建立，实际仓库工具、Anthropic 适配器和隔离执行能力仍在开发中。第一版使用 TypeScript 实现，核心保持为一个直接的模型—工具循环，不依赖 LangChain 或 LangGraph。

## 快速开始

要求 Node.js 22 和 npm 10：

```bash
npm ci
npm run verify
npm run dev -- --help
```

当前 CLI 只提供帮助和版本信息；在安全边界和工具实现完成前，它不会接受真实修复任务。

项目的工程约定在以下文档中：

- [`AGENTS.md`](./AGENTS.md)：所有编码 Agent 必须遵守的仓库指令
- [`docs/architecture.md`](./docs/architecture.md)：模块边界、运行流程和安全不变量
- [`docs/decisions/`](./docs/decisions/)：架构决策记录
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)：Issue、分支、Commit 和 PR 规范
- [`SECURITY.md`](./SECURITY.md)：安全问题报告方式

## 为什么做这个项目

模型已经能够生成相当不错的代码，真正困难的是让它在真实仓库中稳定工作：

- 找到正确的上下文，而不是读取整个仓库
- 理解项目约束，而不是只满足表面需求
- 使用工具取得环境反馈，而不是凭空判断完成
- 在测试失败后定位原因并有限重试
- 控制修改范围、命令权限、成本和运行时间
- 知道什么时候应该停止，并把问题交还给开发者
- 用可重复的任务集判断 Agent 是否真的在进步

Issue Fix Agent 是一个用于学习这些问题的工程实验室。我们不仅用它修复其他项目，也会逐步让它参与开发自己。

## 设计理念

### 1. 从最简单的 Agent Loop 开始

Agent 的核心不是工作流图，而是由模型根据环境反馈决定下一步：

```text
Issue + Repository + Instructions
                │
                ▼
          Claude API Call
                │
       ┌────────┴────────┐
       │                 │
    tool_use          end_turn
       │                 │
       ▼                 ▼
Permission Check     Final Report
       │
       ▼
 Execute Tool
       │
       ▼
 Append Result ────────► next API call
```

路径不由程序预先写死。模型可以先搜索、再阅读、再修改，也可以在测试失败后回到代码继续调查。Harness 只负责提供能力、反馈和边界。

### 2. 模型负责决策，程序负责约束

模型决定：

- 下一步需要了解什么
- 应该使用哪个工具
- 哪些文件可能需要修改
- 如何根据测试错误继续修复
- 何时认为任务已经完成

程序负责：

- 哪些目录可以读取或写入
- 哪些命令可以执行
- 工具参数是否合法
- 最大轮次、时间和费用预算
- 测试是否真的通过
- 修改是否越界
- 运行过程是否可追踪和恢复

### 3. 环境反馈优先于自我判断

Agent 不能仅用“我已经完成了”作为成功证据。完成状态必须尽可能来自外部事实：

- lint 通过
- 类型检查通过
- 测试通过
- 修改仅发生在允许范围内
- 验收条件被对应的测试或检查覆盖

### 4. 安全失败优于勉强成功

遇到需求含糊、权限不足、测试基础设施损坏或修改风险过高时，Agent 应停止并生成阻塞报告，而不是扩大范围或隐藏失败。

### 5. 每一次运行都必须可评测

每次任务都保存输入、工具调用、文件差异、检查结果、耗时和 token 使用。没有评测数据，就无法区分真正的改进和偶然成功。

## 第一版范围

第一版只支持：

- 本地 Git 仓库
- Markdown 或 YAML 格式的 Issue
- 单 Agent、单任务串行执行
- Git worktree 中的隔离修改
- 明确配置的验证命令
- 人工审查后再提交或创建 PR

第一版明确不做：

- 通用 IDE 或代码补全
- 多模型自动路由
- 云端任务调度平台
- 向量数据库和全仓库 RAG
- 完全无人监管地合并代码
- 复杂的预定义工作流图

## 任务契约

Agent 接收的不是一句模糊愿望，而是一份最小任务契约：

```yaml
title: Add case-insensitive email search

description: |
  Add an optional email query to the user list endpoint.

acceptance_criteria:
  - Partial email matches are supported
  - Matching is case-insensitive
  - Existing pagination behavior is unchanged

allowed_paths:
  - src/users/**
  - tests/users/**

verification:
  - npm run lint
  - npm run typecheck
  - npm test -- users

limits:
  max_iterations: 8
  max_changed_files: 10
  timeout_minutes: 20
```

并非每个字段都必须由人填写。未来可以让 Agent 补全建议值，但最终执行边界必须明确且可检查。

## 计划中的工具

MVP 只提供少量、高质量工具：

| 工具          | 作用                      | 默认权限                 |
| ------------- | ------------------------- | ------------------------ |
| `list_files`  | 查看有限深度的目录结构    | 只读、自动允许           |
| `search_code` | 按文本或模式搜索代码      | 只读、自动允许           |
| `read_file`   | 分段读取文件              | 只读、自动允许           |
| `apply_patch` | 以可审查的 patch 修改文件 | 仅限 worktree 和允许路径 |
| `run_command` | 执行测试和项目命令        | 受 allowlist 与沙箱限制  |
| `git_diff`    | 获取当前改动及统计信息    | 只读、自动允许           |

工具应该返回紧凑、结构化、可操作的结果。超长输出必须截断并提供继续读取的方法，避免一次工具调用污染整个上下文。

## 核心循环

下面是目标实现的简化形式：

```ts
while (budget.canContinue()) {
  const response = await model.createMessage({
    system: instructions,
    messages,
    tools: registry.definitions(),
  });

  messages.push(response.message);

  if (response.stopReason === "end_turn") {
    return finalize(response, workspace, verification);
  }

  for (const call of response.toolCalls) {
    const decision = permissions.check(call, workspace.policy);
    const result = decision.allowed
      ? await registry.execute(call)
      : ToolResult.denied(decision.reason);

    trace.record(call, result);
    messages.push(result.toMessage());
  }
}

return stopWithReport("budget_exhausted");
```

生产版本需要处理 streaming、中断、无效参数、工具异常、输出截断、上下文压缩和恢复，但这些能力都围绕同一个循环逐步增加。

## 代码结构

```text
issue-fix-agent/
├── .github/           # CI、安全扫描、Issue 与 PR 模板
├── docs/
│   └── decisions/     # Architecture Decision Records
├── src/
│   ├── agent/          # Agent loop、上下文和停止条件
│   ├── model/          # 模型接口与 Anthropic 适配器
│   ├── tools/          # 工具定义和执行器
│   ├── permissions/    # 路径、命令和操作策略
│   ├── workspace/      # Git worktree 生命周期
│   ├── verification/   # 验证命令和结果汇总
│   ├── trace/          # 运行日志和可观测性
│   └── cli/            # 命令行入口
├── evals/
│   ├── fixtures/       # 可重复运行的小型仓库
│   └── tasks/          # 固定 Issue 评测集
├── tests/
│   └── unit/           # 确定性单元测试
├── examples/
├── AGENTS.md           # AI 开发协议
└── CONTRIBUTING.md     # Git 与协作规范
```

模块边界服务于测试和替换，不追求提前抽象。只有出现第二个真实实现时，才提取通用接口。

## 预期使用方式

目标 CLI：

```bash
issue-fix run \
  --repo ../example-project \
  --issue ./issues/email-search.yaml
```

运行结束后生成：

```text
.issue-fix/runs/<run-id>/
├── task.yaml
├── trace.jsonl
├── result.md
├── verification.json
└── changes.patch
```

`result.md` 应回答：

- 修改了什么，以及为什么
- 哪些验收条件已经满足
- 运行了哪些检查，结果如何
- 是否存在未解决问题或风险
- 开发者审查时应该重点看哪里

## 安全边界

默认策略：

- 所有写入发生在临时 Git worktree 中
- 禁止修改 worktree 之外的文件
- 禁止读取常见凭据目录和敏感文件
- 网络访问默认关闭
- 命令使用结构化参数执行，不通过字符串拼接 shell
- 破坏性 Git 和文件操作默认拒绝
- 超出允许路径的修改会使任务失败
- 达到时间、轮次或成本上限后立即停止
- Agent 不负责合并 PR，也不负责部署

LLM 输出始终被视为不可信输入。任何工具调用在执行之前都必须经过独立的参数校验和权限判断。

## 如何判断 Agent 是否进步

固定评测集中的每个任务都记录：

- `resolved`：验收测试是否通过
- `regression_free`：原有测试是否保持通过
- `scope_compliant`：是否只修改允许范围
- `iterations`：模型调用轮次
- `tool_errors`：无效或失败的工具调用次数
- `human_edits`：人工接手后需要修改的代码量
- `elapsed_time`：总耗时
- `token_usage`：输入和输出 token

最重要的指标不是生成代码行数，而是：

> 人工审查并接受这份修复，是否比开发者亲自实现更省时间？

## 开发路线

### Milestone 0：最小闭环

- [x] 初始化 TypeScript CLI
- [ ] 接入 Anthropic Messages API
- [ ] 实现 `read_file`、`search_code`、`apply_patch`、`run_command`
- [x] 实现单 Agent 工具循环骨架
- [ ] 保存完整 JSONL trace（当前只有 Trace 接口）
- [ ] 使用一个 fixture repository 完成首个 Issue

### Milestone 1：可信执行

- [ ] Git worktree 隔离
- [ ] 路径与命令权限策略
- [ ] Zod 工具参数校验
- [ ] 轮次、时间和 token 预算
- [ ] 验证结果与最终报告
- [ ] 中断和失败处理

### Milestone 2：上下文工程

- [ ] 仓库指令文件
- [ ] 大文件分段读取
- [ ] 工具输出截断
- [ ] 上下文压缩
- [ ] 会话恢复

### Milestone 3：评测驱动开发

- [ ] 建立 10～20 个固定 Issue
- [ ] 自动运行评测集
- [ ] 生成成功率和成本报告
- [ ] 对失败原因分类
- [ ] 使用回归评测约束 Prompt 和工具修改

### Milestone 4：真实仓库与自举

- [ ] 支持从 GitHub Issue 读取任务
- [ ] 生成候选分支和 PR 描述
- [ ] 在一个真实项目中连续完成小型 Issue
- [ ] 让 Agent 尝试实现本仓库中带 `agent-ready` 标签的 Issue

## 有意推迟的能力

以下能力只有在评测证明它们能够解决真实失败时才会加入：

- Subagent
- 长期记忆
- 语义代码索引
- 多模型路由
- 浏览器工具
- 自动 PR review
- LangGraph 或其他编排框架

这条规则用于防止项目变成 Agent 技术陈列馆：每个新能力都必须对应一种已经观察到的失败模式。

## Dogfooding 规则

当最小闭环可用后，本仓库的 Issue 分为两类：

- `agent-ready`：边界明确、具备验收条件，允许 Agent 尝试
- `human-required`：涉及架构决策、安全策略或需求仍不确定，需要人主导

每次 Agent 失败都应该产生至少一种可复用资产：

- 一个回归测试
- 一条仓库指令
- 一个工具改进
- 一项权限规则
- 一个新的评测任务

不要只手工修正最终代码，否则下一次仍会以相同方式失败。

## 项目原则

1. 保持核心循环可读。
2. 工具少而清晰，优先提升反馈质量。
3. 安全边界由代码强制执行，不能只写进 Prompt。
4. 先有真实失败，再增加复杂机制。
5. 所有行为可追踪，所有改进可评测。
6. 正常情况自主完成，异常情况明确交还给人。

## License

许可证尚未确定。在许可证加入之前，本仓库代码默认保留所有权利。
