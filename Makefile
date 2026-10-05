include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wanpilot
PKG_VERSION:=1.2.5
PKG_RELEASE:=3
PKG_LICENSE:=MIT
PKG_MAINTAINER:=itnetsteven

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-wanpilot
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=WanPilot dual-WAN manager
  DEPENDS:=+luci-base +mwan3 +luci-app-mwan3
  PKGARCH:=all
endef

define Package/luci-app-wanpilot/description
 WanPilot is a LuCI multi-WAN management interface for OpenWrt/iStoreOS
 built on mwan3. It provides WAN status, load-balance control,
 per-device routing, failover-aware policies, protected apply/confirm,
 diagnostics and emergency recovery.
endef

define Build/Compile
endef

define Package/luci-app-wanpilot/conffiles
/etc/config/wanpilot
endef

define Package/luci-app-wanpilot/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/wanpilot
	$(CP) ./htdocs/luci-static/resources/view/wanpilot/* $(1)/www/luci-static/resources/view/wanpilot/
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./root/etc/config/wanpilot $(1)/etc/config/wanpilot
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./root/usr/libexec/* $(1)/usr/libexec/
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(CP) ./root/usr/share/luci/menu.d/* $(1)/usr/share/luci/menu.d/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(CP) ./root/usr/share/rpcd/acl.d/* $(1)/usr/share/rpcd/acl.d/
endef

define Package/luci-app-wanpilot/postinst
#!/bin/sh
[ -n "$$$$IPKG_INSTROOT" ] && exit 0
mkdir -p /etc/wanpilot /var/lock
[ -x /usr/libexec/wanpilot-init-ifaces ] && /usr/libexec/wanpilot-init-ifaces 2>/dev/null || true
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
  /etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

$(eval $(call BuildPackage,luci-app-wanpilot))
