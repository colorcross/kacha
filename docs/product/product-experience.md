# Product experience

> 对账修订：`kacha-product-optimization-2026-08-30`。

## 信息架构与产品形态

产品由自然语言 Agent 入口、`kacha.mjs` 确定性 CLI、本地 Studio、项目 `.kacha`
控制面和文档/合同构成。Studio 包含新建项目、项目状态、内容项目、专业调整和统一
审片；项目状态台提供只读制作飞行记录。

## 关键用户旅程与页面关系

主旅程是 `start → status/run/resume → Timeline IR/render → QC → 人工审片 → release`
。参考片旅程在 `start` 前增加版权分析与原创派生；外部能力旅程在执行前增加
能力决策、费用预占和一次性消费；素材旅程由 media index 派生 clip corpus，但不
替代原索引，并在检索前重验当前索引和源文件身份。

专业调整旅程为 `打开 Timeline IR → 选择类型化轨道条目 → Inspector 修改 → 原子
Command → required QC → 撤销/重做 → 重新渲染与审片`。浏览器 session 只绑定首次
打开的 Timeline，后续请求不能改写目标路径；发现外部修改、journal 断链或 session
过期时失败关闭。journal 损坏后可显式恢复最后有效快照；确认外部修改合法时可显式
重开 session。播放器显示源时间，Timeline 显示并控制 EDL 映射后的成片时间。

## 主要交互、异常与恢复

所有长任务以文件状态恢复。输入身份变化、运行版本变化、能力缺失、版权未知、
费用未知、预算不足、重复消费、参考片仅允许分析、权利证据缺失或源身份漂移均
失败关闭。Studio 飞行记录只有带本地读标识的 GET 观察接口；写操作继续
使用带本地来源标记的既有 POST 接口。空事件、读取中、就绪和错误状态分别呈现。
调整页另有等待打开、近似预览、只读条目、可编辑条目、冲突和 required QC 状态；
窄屏保持任务可读与字段可操作，但不把近似预览伪装成正式渲染。

## 安装、启动与官网体验

官网主命令明确选择 `canary`（跟随 `main`），稳定线需显式改为 `stable`；当前
stable 仍是 `v1.1.0`，不能用当前 main 的能力说明冒充稳定版能力。checkout 安装
优先读取本地 `config/release-channels.json`；stdin 安装只从固定官方 HTTPS 地址
读取同一合同，解析或校验失败即停止，且任何路径都不覆盖已有 skill。

Studio 在监听端口并输出“running”之前完成不可变目录预热，因此用户看到可用地址后
首个 bootstrap 不再重复读取 18 MB 动效合同。自定义风格仍按请求读取，不因缓存而
隐藏。官网 `/` 与 `/en/` 使用相同视觉组件，但分别在 `html` 根节点声明 `zh-CN`
和 `en`，桌面与 390 px 窄屏均为正式验收视口。
