# 贡献指南

感谢你改进咔嚓。

## 开始前

- 先阅读 `SKILL.md` 及相关 `references/`；
- 大改动先开 issue，说明目标、使用场景和失败边界；
- 不要提交真实项目素材、凭据、模型权重或未获授权的第三方资产；仓库内置原创音效必须有作者确认、独立资产许可和双哈希清单。

## 变更原则

- 保持源素材只读，输出不得静默覆盖；
- 保持“方案、执行、自动 QC、人工审片、上传、发布”的状态区分；
- 新效果必须定义触发条件、机制、简单替代、失败条件和 QC 证据；
- 新外部能力必须有当前运行时探测，不能只引用旧文档；
- 付费、上传、发布和不可逆操作必须显式授权；
- 自动化不能伪造人工试听或通看证据。

## 本地检查

```bash
node tests/run_tests.mjs
python3 scripts/scan_secrets.py
git diff --check
```

修改脚本时还应运行对应语法检查：

```bash
node --check scripts/example.mjs
bash -n scripts/example.sh
python3 -m py_compile scripts/example.py
swiftc -parse scripts/generate_vision_masks.swift
```

## Pull request

PR 描述应包含：

- 问题与用户影响；
- 根因或设计理由；
- 具体修改；
- 失败和回退路径；
- 测试证据；
- 平台限制和未验证项；
- 是否影响隐私、付费或外部调用。

提交即表示你有权按本仓库许可证提供相关内容。
