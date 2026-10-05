# WanPilot

WanPilot is a LuCI multi-WAN management interface for **OpenWrt / iStoreOS**, built on top of **mwan3**.

It focuses on a simpler day-to-day workflow for dual-WAN routers: see both lines at a glance, change the default traffic ratio, assign devices to a preferred line, enable failover, and apply changes through a protected transaction with automatic confirmation and rollback protection.

## Features

- Dual-WAN live status for `wan` and `wan1`
- WAN/WAN1 traffic ratio control
- Per-device routing rules
- Failover-aware device routing
- Dynamic **Save & Apply** progress display
- Protected apply / confirm workflow
- Automatic rollback protection when an apply cannot be confirmed
- Read-only diagnostics and rule-hit inspection
- Emergency recovery page
- Automatic WAN interface detection during first installation when possible
- Direct access to the native mwan3 LuCI manager for advanced configuration

## Requirements

- OpenWrt / iStoreOS with LuCI
- `mwan3`
- `luci-app-mwan3`

The package declares these dependencies, so `opkg` will install them automatically when the configured package repositories provide them.

## Tested environment

The current release was developed and verified primarily on:

- iStoreOS 22.03.7
- x86_64
- dual WAN: `wan` + `wan1`
- mwan3 / firewall4 environment

The current 1.2.5 code still contains assumptions for a `192.168.188.0/24` LAN in the device shortcut workflow and recovery text. Other LAN subnets should be treated as **not yet officially supported** until that logic is generalized and tested.

Failover policy generation has been configuration-validated. Physical WAN cable-disconnect failover has not yet been formally regression-tested for this release.

## Install

Download the latest IPK release and copy it to the router, then run:

```sh
opkg install /tmp/luci-app-wanpilot_1.2.5-3_all.ipk
```

If your package lists are stale, update them first:

```sh
opkg update
```

After installation, refresh LuCI in the browser. WanPilot appears under the Network section.

## Upgrade

Install the newer IPK over the existing version:

```sh
opkg install /tmp/luci-app-wanpilot_<version>_all.ipk
```

`/etc/config/wanpilot` is treated as a conffile so an existing configuration is not intentionally replaced during a normal upgrade.

## Safety model

WanPilot does not directly treat a UI click as proof that a network change is safe. The protected apply path uses staged candidate configuration, pre-apply recovery snapshots, transaction state checks, quick health guards, configuration fingerprints and explicit confirmation.

If the protected transaction cannot be confirmed, the rollback mechanism is designed to restore the previous mwan3 configuration.

## Build with the OpenWrt SDK

Place this repository in an OpenWrt SDK/package feed and build it like a normal package:

```sh
make package/luci-app-wanpilot/compile V=s
```

The package metadata declares:

```text
+luci-base +mwan3 +luci-app-mwan3
```

## Source layout

```text
.
├── Makefile
├── htdocs/
│   └── luci-static/resources/view/wanpilot/
├── root/
│   ├── etc/config/wanpilot
│   └── usr/
│       ├── libexec/
│       └── share/
└── LICENSE
```

## Current release

**v1.2.5**

Highlights:

- redesigned device-routing UI
- WAN blue / WAN1 purple visual system
- failover-aware preferred-line policies
- dynamic Save & Apply progress state
- automatic confirmation after protected application
- emergency recovery retained outside the normal operation flow
- package dependency on mwan3

## License

MIT License. See [LICENSE](LICENSE).

## Project status

WanPilot is still evolving. Before using it on a remote-only router, verify that you have a local recovery path and understand your current mwan3 configuration.
