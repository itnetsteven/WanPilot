# Changelog

## 1.2.5-3 - 2026-10-05

Public-source packaging refresh.

- Added formal OpenWrt package Makefile.
- Declared `luci-base`, `mwan3` and `luci-app-mwan3` dependencies.
- Preserved the 1.2.5 dynamic Save & Apply progress UI.
- Included current LuCI ACL and menu definitions.
- Included WAN auto-detection helper used by package installation.
- Removed local device-specific fallback names from the public source tree.
- Kept the default configuration free of local device-routing rules.

## 1.2.5-2

- Added mwan3 installation dependencies to the IPK package metadata.

## 1.2.5-1

- Added dynamic Save & Apply progress UI.
- Kept protected apply, automatic confirmation and rollback behavior.
