# WanPilot v1.2.5

首个公开发布版本 / Initial public release.

## 中文

WanPilot 是一个基于 mwan3 的 OpenWrt / iStoreOS 双 WAN 管理界面，重点简化日常双线路管理，并保留受保护的配置应用与恢复机制。

### 主要功能

- WAN / WAN1 双线路实时状态
- 默认流量分担比例调整
- 单设备指定上网线路
- Failover 故障切换策略
- 动态“保存并应用”进度显示
- Apply / Confirm 安全事务流程
- 异常自动回滚
- 诊断状态与应急恢复页面
- 原生 mwan3 高级管理入口
- 安装时声明 mwan3 / luci-app-mwan3 依赖

### 当前验证环境

- iStoreOS 22.03.7
- x86_64
- mwan3 / firewall4
- 双 WAN：wan + wan1

### 已知限制

- 当前 1.2.5 部分设备快捷分流与恢复提示仍假设 LAN 为 192.168.188.0/24。
- Failover 策略已完成配置级验证，但本版本尚未完成正式的物理拔线回归测试。
- 远程路由器安装和修改网络策略前，建议确保有本地 LAN 或终端恢复方式。

## English

WanPilot is a LuCI dual-WAN management interface for OpenWrt / iStoreOS, built on top of mwan3.

### Highlights

- Live WAN / WAN1 status
- Default traffic ratio control
- Per-device routing
- Failover-aware preferred-line policies
- Dynamic Save & Apply progress
- Protected Apply / Confirm workflow
- Automatic rollback protection
- Diagnostics and emergency recovery
- Native mwan3 advanced-management entry
- Package dependencies for mwan3 and luci-app-mwan3

### Tested environment

- iStoreOS 22.03.7
- x86_64
- mwan3 / firewall4
- dual WAN: wan + wan1

### Known limitations

- Some 1.2.5 device-routing and recovery text still assumes a 192.168.188.0/24 LAN.
- Failover policy generation is configuration-validated; formal physical cable-disconnect regression testing has not yet been completed for this release.
