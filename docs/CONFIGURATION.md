# 配置、默认剪辑要求与密钥

咔嚓把三类内容分开：

1. 仓库可管理的安全默认值；
2. 用户或项目的默认剪辑偏好；
3. 只保存在本机的 API 密钥。

配置可以改变工作参数和默认偏好，不能赋予上传、付费、发布、覆盖源文件或
跳过 QC/人工审片的权限。逐项目 manifest/context 中的授权仍是唯一执行依据。

## 配置层与优先级

从低到高依次为：

1. `config/defaults.json`：随 Skill 发布的安全默认值；
2. `~/.config/kacha/config.json`：当前用户的长期默认值；
3. 从项目锚点向上找到的 `kacha.config.json`：可提交的项目配置；
4. `kacha.local.json`：项目本机覆盖，已加入 `.gitignore`；
5. `--config FILE` 或 `KACHA_CONFIG`：显式配置；
6. 当前命令行参数。

对象字段做深度合并。自然语言要求按 `id` 合并并去重；更高层的同名 `id`
覆盖低层。命令行参数始终优先，例如 `--model-tier`、`--max-frames` 和
`--handle-frames`。

`KACHA_CONFIG_HOME` 可以改变用户配置目录；`XDG_CONFIG_HOME` 也受支持。
测试或隔离运行可设置 `KACHA_DISABLE_USER_CONFIG=1`。

### 自动项目配置的信任边界

`kacha.config.json` 和 `kacha.local.json` 会被自动发现，因此不能设置
`providers` 或 `tools`。这样，项目文件不能改写凭证环境变量、MiniMax API
地址或本机可执行程序路径。下列内容只允许放在用户配置，或由用户通过
`--config FILE` 显式选择的配置中：

- `providers.*`；
- `tools.demucsBin`；
- `tools.sfxLibrary`。

项目配置仍可设置 `editingDefaults` 和经过范围校验的 `execution` 参数。
显式配置与自动发现文件指向同一路径时，以显式配置身份读取。

## 初始化与检查

创建用户配置和权限为 `0600` 的空密钥文件：

```bash
node scripts/kacha.mjs config init --scope user
```

重复执行是幂等的：已有且有效的文件保持不变，缺少的密钥文件会补建，不会
覆盖用户内容。

创建当前项目的 `kacha.config.json`：

```bash
node scripts/kacha.mjs config init --scope project
```

查看合并后的安全配置和密钥来源状态：

```bash
node scripts/kacha.mjs config show --anchor /path/to/project
```

输出只显示“来自环境、密钥文件、mmx 凭证库或未配置”，不会输出密钥值。

只做校验：

```bash
node scripts/kacha.mjs config validate --anchor /path/to/project
```

密钥文件在 POSIX 系统上只允许当前用户访问。权限过宽时会失败：

```bash
chmod 600 ~/.config/kacha/secrets.json
```

## 参数与自然语言要求

`editingDefaults` 同时支持结构化参数和自然语言：

```json
{
  "schemaVersion": "1.0",
  "editingDefaults": {
    "parameters": {
      "subtitle": {
        "singleLine": true,
        "safeAreaBottomRatio": 0.18
      }
    },
    "instructions": [
      {
        "id": "calm-delivery",
        "text": "保留淡定、幽默、娓娓道来的表达，不要把自然停顿全部剪掉。",
        "appliesTo": ["source_edit", "local_optimization"],
        "modules": ["dialogue", "bgm", "sfx"],
        "priority": "high"
      },
      "外加画面必须匹配当前视频的对象、动作、角色、时态和整体风格。"
    ],
    "recipeParameters": {
      "beauty": {
        "profile": "natural"
      }
    }
  }
}
```

- `parameters`：供完整流程和代理读取的通用结构化要求；
- `instructions`：字符串或对象数组；对象可限定任务、模块和优先级；
- `recipeParameters`：为 `compile-change` 的稳定配方提供默认参数；
- 当前 change request 的 `parameters` 会覆盖配方默认值。

`prepare` 把适用于当前任务/模块的要求写入 `agent-packet.json`。
`compile-change` 把配方默认参数、自然语言要求和配置摘要写入当前 delta，
因此较弱模型和长任务续跑不需要重新从对话中猜测用户习惯。

完整结构示例见
[`examples/kacha.config.json`](../examples/kacha.config.json)。用户级敏感连接项
示例见
[`examples/kacha-user.config.json`](../examples/kacha-user.config.json)。

## 可配置的运行参数

`execution` 当前覆盖：

- 模型档位和 reference token 预算；
- 增量返工的默认 handle 帧数；
- 视觉证据的模式、帧数、场景阈值、并发数和图片边长；
- MiniMax 关键帧上限、超时、图片大小和网络方式；
- black/freeze/silence 探测与响度测量参数；
- Demucs 模型、设备和时长容差；
- 人声美化 preset、降噪、declick、目标响度、true peak 和声道策略；
- 网络素材的候选数量与超时。

用户配置或显式配置中的 `tools.demucsBin` 和 `tools.sfxLibrary` 可保存
本机绝对路径。环境变量
`KACHA_DEMUCS_BIN`、`KACHA_SFX_LIBRARY` 仍可用于临时覆盖。

安全合同、授权、源文件只读、输出不覆盖、完整语义、PTS 共边界和 release
门禁不是可调参数。

## 密钥

密钥文件默认位于：

```text
~/.config/kacha/secrets.json
```

结构：

```json
{
  "schemaVersion": "1.0",
  "providers": {
    "minimax": { "apiKey": "" },
    "pixabay": { "apiKey": "" },
    "pexels": { "apiKey": "" }
  }
}
```

也可通过 `--secrets FILE` 或 `KACHA_SECRETS_FILE` 指定其他位置。

凭证优先级：

1. provider 对应的环境变量；
2. `secrets.json`；
3. MiniMax 的 `~/.mmx/config.json`/OAuth 凭证库；
4. 网络素材下载器兼容的旧 `media.env`。

默认环境变量名为 `MINIMAX_API_KEY`、`PIXABAY_API_KEY` 和
`PEXELS_API_KEY`，可以在安全配置的 `providers.*.credentialEnv` 中改名。
咔嚓只把密钥注入需要它的子进程，不把值写入执行包、QC、缓存、日志或
Git。MiniMax 密钥通过子进程环境传入，不作为命令行参数暴露在进程列表。

MiniMax 默认 `cn` 区域和无代理直连；可把
`execution.minimaxVision.networkMode` 设置为 `configured_environment`，
或在单次命令中使用 `--use-configured-network`。网络配置不等于外传授权。

## 版本控制建议

- 可以提交：`kacha.config.json`；
- 不要提交：`kacha.local.json`、`secrets.json`、`.env`、真实素材与输出；
- 发布前运行 `python3 scripts/scan_secrets.py`；
- 不要把真实密钥复制到 issue、日志、agent packet 或 project manifest。
