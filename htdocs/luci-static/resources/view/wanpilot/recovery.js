'use strict';
'require view';
'require fs';
'require ui';

return view.extend({
  load: function() {
    return fs.exec('/usr/libexec/wanpilot-recovery', ['status']);
  },

  render: function(data) {
    var out = (data && data.stdout) || '';
    var state = {};
    out.split(/\n/).forEach(function(line) {
      var p = line.indexOf('=');
      if (p > 0) state[line.slice(0, p)] = line.slice(p + 1);
    });

    var statusBox = E('div', {'class':'cbi-section', 'style':'border:1px solid #cbd5e1;border-radius:12px;padding:16px;margin:12px 0'}, [
      E('h3', {}, '最近一次应用前快照'),
      E('p', {}, state.snapshot_exists === 'yes'
        ? ('保存时间：' + (state.created_at || '未知') + '　快照：' + (state.snapshot_id || '未知'))
        : '当前没有可用的应用前快照。'),
      E('p', {}, '快照完整性：' + (state.snapshot_integrity || '—')),
      E('p', {}, '当前配置与快照：' + (state.live_matches_snapshot === 'yes' ? '一致' : (state.snapshot_exists === 'yes' ? '不同' : '—'))),
      E('p', {}, 'UCI 状态：' + (state.uci_clean === 'yes' ? '干净' : '存在未提交修改')),
      E('p', {}, '设备安全事务：' + (state.device_pending === 'yes' ? '进行中' : '无') + '　全局安全事务：' + (state.global_pending === 'yes' ? '进行中' : '无')),
      state.last_result ? E('p', {}, '最近恢复结果：' + state.last_result) : ''
    ]);

    var result = E('pre', {'style':'white-space:pre-wrap;min-height:42px;background:#f8fafc;border-radius:8px;padding:10px'}, '');
    var disabled = state.snapshot_exists !== 'yes' || state.snapshot_integrity !== 'ok' || state.uci_clean !== 'yes' || state.device_pending === 'yes' || state.global_pending === 'yes' || state.live_matches_snapshot === 'yes';
    var button = E('button', {
      'class':'btn cbi-button-negative',
      'disabled': disabled,
      'click': ui.createHandlerFn(this, function() {
        if (!window.confirm('这会把 mwan3 恢复到最近一次“应用前快照”，并重启 mwan3。\n\n仅在网络调整后出现异常时使用。确认继续？')) return Promise.resolve();
        button.disabled = true;
        result.textContent = '正在执行恢复…';
        return fs.exec('/usr/libexec/wanpilot-recovery', ['restore']).then(function(r) {
          result.textContent = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
          if (r.code === 0) {
            ui.addNotification(null, E('p', {}, '恢复操作已执行。请重新检查 WAN 状态。'), 'info');
            window.setTimeout(function(){ window.location.reload(); }, 1500);
          } else {
            ui.addNotification(null, E('p', {}, '恢复失败，未继续执行其他网络修改。'), 'danger');
            button.disabled = false;
          }
        }).catch(function(e) {
          result.textContent = String(e);
          button.disabled = false;
        });
      })
    }, '恢复到应用前状态');

    return E('div', {}, [
      E('h2', {}, 'WanPilot 应急恢复'),
      E('p', {}, '此页面只用于网络调整后出现异常时恢复最近一次应用前的 mwan3 配置。日常设置请返回 WanPilot 主页面。'),
      E('div', {'class':'alert-message warning'}, '恢复页依赖路由器 LAN 管理仍可访问。如果 192.168.188.1 本身无法访问，需要通过本地终端或其他维护方式处理。'),
      statusBox,
      E('div', {'class':'cbi-section'}, [button]),
      result
    ]);
  },

  handleSaveApply: null,
  handleSave: null,
  handleReset: null
});
