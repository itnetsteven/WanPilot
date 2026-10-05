'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';


// A recovery snapshot is mandatory before starting either existing safe backend.
function wpCaptureBeforeApply(reason) {
  return fs.exec('/usr/libexec/wanpilot-recovery', ['capture', reason]).then(function(r) {
    if (!r || r.code !== 0 || !/captured=/.test(r.stdout || ''))
      throw new Error('应用前恢复点保存失败：' + ((r && r.stderr) || (r && r.stdout) || '未知错误'));
    return r;
  });
}
function wpParseStatus(body) {
  var fields = {};
  String(body || '').split(/\r?\n/).forEach(function(line) {
    var i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1).trim();
  });
  return fields;
}
function wpConfirmPending(kind) {
  var backend = kind === 'device' ? '/usr/libexec/wanpilot-safe' : '/usr/libexec/wanpilot-global-safe';
  var label = kind === 'device' ? '设备线路' : '全局比例';
  var candidateSha = '';
  return fs.exec(backend, ['status']).then(function(status) {
    if (!status || status.code !== 0) throw Error(label + '应用后无法读取事务状态');
    var f = wpParseStatus(status.stdout);
    if (f.pending !== 'yes' || f.state !== 'pending')
      throw Error(label + '应用后未进入待确认状态：' + (f.state || 'unknown'));
    if (!/^[0-9a-f]{64}$/.test(f.candidate_sha || '') || f.candidate_sha !== f.live_sha)
      throw Error(label + '应用后候选配置与当前运行配置不一致');
    candidateSha = f.candidate_sha;
    return fs.exec('/usr/libexec/wanpilot-quick-guard', [kind, candidateSha]);
  }).then(function(guard) {
    if (!guard || guard.code !== 0)
      throw Error(label + '连通性/事务检查未通过：' + ((guard && (guard.stderr || guard.stdout)) || '未知错误'));
    return fs.exec(backend, ['status']);
  }).then(function(fresh) {
    if (!fresh || fresh.code !== 0) throw Error(label + '确认前无法重新读取事务状态');
    var f = wpParseStatus(fresh.stdout);
    if (f.pending !== 'yes' || f.candidate_sha !== candidateSha || f.live_sha !== candidateSha)
      throw Error(label + '确认前事务状态发生变化，保持自动回滚保护');
    return fs.exec(backend, ['confirm']);
  }).then(function(confirmed) {
    if (!confirmed || confirmed.code !== 0)
      throw Error(label + '确认失败：' + ((confirmed && (confirmed.stderr || confirmed.stdout)) || '未知错误'));
    return fs.exec(backend, ['status']);
  }).then(function(finalStatus) {
    if (!finalStatus || finalStatus.code !== 0) throw Error(label + '确认后无法读取最终状态');
    var f = wpParseStatus(finalStatus.stdout);
    if (f.pending !== 'no' || f.state !== 'confirmed')
      throw Error(label + '未完成最终确认：state=' + (f.state || 'unknown') + ', pending=' + (f.pending || 'unknown'));
    if (candidateSha && f.live_sha && f.live_sha !== candidateSha)
      throw Error(label + '确认后运行配置指纹发生变化');
    return f;
  });
}
// Compatibility for the collapsed maintenance controls. Routine Save & Apply does not use them.
function wpRetainAfterSuccessfulApply(kind) {
  return wpConfirmPending(kind).then(function(){
    ui.addNotification(null, E('p', {}, '配置已确认保留。'), 'info');
    return true;
  }).catch(function(err){
    ui.addNotification(null, E('p', {}, '确认未完成，仍由自动回滚保护：' + String(err)), 'danger');
    return false;
  });
}
// Complete one protected transaction without relying on legacy buttons or backend prose.
function wpApplyAndConfirm(kind) {
  var backend = kind === 'device' ? '/usr/libexec/wanpilot-safe' : '/usr/libexec/wanpilot-global-safe';
  var label = kind === 'device' ? '设备线路' : '全局比例';
  return wpCaptureBeforeApply(kind + '-save-apply').then(function() {
    return fs.exec(backend, ['check']);
  }).then(function(check) {
    if (!check || check.code !== 0)
      throw Error(label + '安全预检失败：' + ((check && (check.stderr || check.stdout)) || '未知错误'));
    return fs.exec(backend, ['apply']);
  }).then(function(applied) {
    if (!applied || applied.code !== 0)
      throw Error(label + '应用失败：' + ((applied && (applied.stderr || applied.stdout)) || '未知错误'));
    return wpConfirmPending(kind);
  });
}

return view.extend({
 load: function() {
    // UCI configuration is essential; status-only helpers must not take down the view.
    return Promise.all([uci.load('wanpilot'), uci.load('mwan3')]).then(function(config) {
      var operations = ['snapshot', 'devices', 'operation-state'];
      return Promise.all(operations.map(function(op) {
        return Promise.resolve().then(function() {
          return fs.exec('/usr/libexec/wanpilot', [op]);
        }).catch(function(err) {
          console.warn('WanPilot: optional status read failed: ' + op, err);
          return { code: 1, stdout: '', stderr: String(err) };
        });
      })).then(function(status) { return config.concat(status); });
    });
  },
 render: function(data) {
  // Resolve elements only inside this WanPilot view, not stale LuCI pages.
  var root = null;
  function viewNode(id) { return root ? root.querySelector('#' + id) : null; }
  var wanSnapshot = parseRows(data[2] && data[2].stdout);
  var leaseRows = parseRows(data[3] && data[3].stdout);
  function parseRows(str) { return (str || "").trim().split(/\n/).slice(1).filter(Boolean).map(function(line) { return line.split("|"); }); }
  function safeInt(v) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function bytes(n) { if (n >= 1073741824) return (n/1073741824).toFixed(2)+" GB"; if (n >= 1048576) return (n/1048576).toFixed(1)+" MB"; return Math.round(n/1024)+" KB"; }
  function bitrate(bytesPerSecond) {
    var bps = Math.max(0, bytesPerSecond * 8);
    return bps >= 1000000 ? (bps / 1000000).toFixed(1) + " Mbps" :
      bps >= 1000 ? (bps / 1000).toFixed(0) + " Kbps" : Math.round(bps) + " bps";
  }
  var m = new form.Map('wanpilot', 'WanPilot 高级策略编辑', '高级设置需单独保存；要让设置真正生效，请进入「应用更改」。');
  // Legacy main.enabled is intentionally not exposed: current safe apply requires it to remain disabled.
  var s = m.section(form.GridSection, 'profile', '线路策略');
  s.anonymous = true; s.addremove = true; s.sortable = true;
  var o;
  o=s.option(form.Value, 'name', '策略名称'); o.rmempty=false; o.placeholder='office';
  o=s.option(form.ListValue,'mode','模式'); o.value('single','固定线路');o.value('failover','主备故障切换');o.value('balance','按连接权重分流');o.default='failover';
  var ifaces = uci.sections('mwan3','interface').map(function(x){return x['.name'];});
  function ifaceOption(key,title){ var a=s.option(form.ListValue,key,title); a.rmempty=false; ifaces.forEach(function(n){a.value(n,n);}); return a; }
  ifaceOption('primary','主 WAN');
  o=ifaceOption('secondary','备用/第二 WAN'); o.depends('mode','failover');o.depends('mode','balance');
  o=s.option(form.Value,'weight_primary','主线权重');o.datatype='range(1,100)';o.default='1';
  o=s.option(form.Value,'weight_secondary','第二线权重');o.datatype='range(1,100)';o.default='1';o.depends('mode','balance');
  var r=m.section(form.GridSection,'rule','定向分流规则（由上到下匹配）');r.anonymous=true;r.addremove=true;r.sortable=true;
  o=r.option(form.Flag,'enabled','启用');o.default='1';
  o=r.option(form.Value,'name','规则名称');o.rmempty=false;o.placeholder='pc01';
  o=r.option(form.ListValue,'device_ip','选择 DHCP 设备（可选）');o.value('', '手工填写 IP'); leaseRows.forEach(function(d){o.value(d[0]+'/32', (d[2] && d[2]!='*' ? d[2]+' · ' : '')+d[0]+' ('+d[1]+')');});
  o=r.option(form.Value,'src_ip','手动来源 IP / CIDR（优先）');o.placeholder='192.168.188.100/32';
  o=r.option(form.Value,'dest_ip','目标 IP / CIDR');o.placeholder='1.1.1.1/32';
  o=r.option(form.Value,'dest_port','目标端口');o.placeholder='443';
  o=r.option(form.ListValue,'proto','协议');['all','tcp','udp','tcpudp','icmp'].forEach(function(x){o.value(x,x);});o.default='all';
  o=r.option(form.Value,'profile','策略名称');o.rmempty=false;o.placeholder='office';
  // The shortcut only writes WanPilot UCI; live mwan3 is changed only by the protected apply path.
  var deviceFailoverEnabled = uci.get('wanpilot','main','device_failover') === '1';
  var presets = {
    'wan': deviceFailoverEnabled ? { name:'devwan', mode:'failover', primary:'wan', secondary:'wan1' } : { name:'devwan', mode:'single', primary:'wan', secondary:'' },
    'wan1': deviceFailoverEnabled ? { name:'devwan1', mode:'failover', primary:'wan1', secondary:'wan' } : { name:'devwan1', mode:'single', primary:'wan1', secondary:'' },
    'balance': { name:'devbal', mode:'balance', primary:'wan', secondary:'wan1' },
    'failover': { name:'devfall', mode:'failover', primary:'wan', secondary:'wan1' }
  };
  function deviceRuleFor(ip) {
    return uci.sections('wanpilot','rule').filter(function(x) {
      return x.src_ip === ip + '/32' || x.device_ip === ip + '/32' || x.src_ip === ip || x.device_ip === ip;
    });
  }
  function assignDevice(ip, choice) {
    if (!/^192\.168\.188\.(?:\d{1,3})$/.test(ip)) {
      ui.addNotification(null, E('p', {}, '只允许在当前 LAN 192.168.188.0/24 中为设备创建快捷规则。'), 'danger');
      return Promise.resolve();
    }
    if (choice === 'default') {
      if (!window.confirm('恢复 '+ip+' 的默认分流？\n仅删除 WanPilot 自动生成的设备规则；不会修改正在运行的 mwan3。')) return Promise.resolve();
      return fs.exec('/usr/libexec/wanpilot', ['remove-device', ip]).then(function(res){
        if (res.code !== 0) { ui.addNotification(null,E('p',{},'撤销失败：'+(res.stderr||res.stdout||res.code)),'danger');return; }
        ui.addNotification(null,E('p',{},'已撤销设备快捷规则；mwan3 未改变。'),'info');
        window.location.reload();
      }).catch(function(e){ui.addNotification(null,E('p',{},'撤销失败：'+String(e)),'danger');});
    }
    if (choice === 'none') {
      ui.addNotification(null, E('p', {}, '未选择线路，不会修改配置。'), 'warning');
      return Promise.resolve();
    }
    var conflicts = deviceRuleFor(ip);
    if (conflicts.some(function(x) { return !/^dev[0-9]{1,3}$/.test(x.name || ''); })) {
      ui.addNotification(null, E('p', {}, '这台设备已经存在手工分流规则。为防止冲突，请在下方规则表中手工调整。'), 'warning');
      return Promise.resolve();
    }
    var p = presets[choice];
    if (!p) return Promise.resolve();
    if (uci.sections('mwan3', 'interface').filter(function(x){return x['.name'] === p.primary || x['.name'] === p.secondary;}).length !== (p.secondary ? 2 : 1)) {
      ui.addNotification(null, E('p', {}, 'mwan3 中未找到所需的 WAN 接口。'), 'danger');
      return Promise.resolve();
    }
    var last = Number(ip.split('.')[3]);
    if (last < 1 || last > 254) return Promise.resolve();
    var rn = 'dev' + last;
    var existing = uci.sections('wanpilot','rule').filter(function(x){return x.name === rn;});
    if (existing.some(function(x){return x.src_ip !== ip+'/32' && x.device_ip !== ip+'/32';})) {
      ui.addNotification(null,E('p',{},'设备规则名称与已有规则冲突，请手工处理。'),'danger');
      return Promise.resolve();
    }
    if (conflicts.length > 1) {
      ui.addNotification(null,E('p',{},'此设备存在多条分流规则，请手工处理。'),'warning');
      return Promise.resolve();
    }
    if (!window.confirm('为 '+ip+' 保存 '+choice+' 分流规则到 WanPilot？\n不会立即修改 mwan3，仍需单独验证与应用。')) return Promise.resolve();
    // Backend commits only /etc/config/wanpilot and verifies persistence.
    // Do not use uci.save() here: it only stages changes in the LuCI session.
    return fs.exec('/usr/libexec/wanpilot', ['assign-device', ip, choice]).then(function(res) {
      if (res.code !== 0) {
        ui.addNotification(null,E('p',{},'保存失败：'+(res.stderr || res.stdout || '返回码 '+res.code)),'danger');
        return;
      }
      ui.addNotification(null,E('p',{},'设备规则已写入 WanPilot 配置（尚未应用到 mwan3）。'),'info');
      window.location.reload();
    }).catch(function(e) {
      ui.addNotification(null,E('p',{},'保存失败：'+String(e)),'danger');
    });
  }
  // V4.0 UI only: detect the existing saved outlet; never write to mwan3 here.
  function savedDeviceOutlet(ip) {
    var rules=deviceRuleFor(ip);
    if(rules.length !== 1 || rules[0].enabled === '0') return 'none';
    var p=uci.sections('wanpilot','profile').find(function(x){return x.name === rules[0].profile;});
    if(!p) return 'none';
    if(p.mode === 'single' && (p.primary === 'wan' || p.primary === 'wan1')) return p.primary;
    if(p.mode === 'failover' && (p.name === 'devwan' || p.name === 'devwan1') && (p.primary === 'wan' || p.primary === 'wan1')) return p.primary;
    if(p.mode === 'balance') return 'balance';
    if(p.mode === 'failover') return 'failover';
    return 'none';
  }
  function outletLabel(mode) {
    var labels=deviceFailoverEnabled ?
      {wan:'WAN 优先 · 故障转 WAN1',wan1:'WAN1 优先 · 故障转 WAN',balance:'双线均衡',failover:'WAN 主 / WAN1 备',none:'需检查现有规则'} :
      {wan:'仅 WAN 主线路',wan1:'仅 WAN1 第二线路',balance:'双线均衡',failover:'WAN 主 / WAN1 备',none:'需检查现有规则'};
    return labels[mode] || '需检查现有规则';
  }
  function deviceRow(d) {
    var ip=d[0], saved=savedDeviceOutlet(ip), rules=deviceRuleFor(ip);
    var label=d[2]&&d[2]!=='*'?d[2]:(ip==='192.168.188.109'?'OPPO-Find-N3':'未命名设备');
    var isManual=rules.some(function(x){return !/^dev[0-9]{1,3}$/.test(x.name||'');});
    var hasConflict=rules.length>1||isManual||saved==='none'&&rules.length>0;
    var preset=rules.length===0?'default':saved;
    var select=E('select',{'class':'cbi-input-select','style':'width:100%;max-width:230px;min-width:150px'},[
      E('option',{'value':'default'},'自动使用默认线路'),
      E('option',{'value':'wan'},deviceFailoverEnabled?'WAN 优先（故障转 WAN1）':'仅 WAN 主线路'),
      E('option',{'value':'wan1'},deviceFailoverEnabled?'WAN1 优先（故障转 WAN）':'仅 WAN1 第二线路'),
      E('option',{'value':'balance'},'两条线路分担')
    ]);
    select.value=hasConflict?'default':preset;
    select.disabled=hasConflict;
    var btn=E('button',{'class':'btn cbi-button-action','type':'button','style':'white-space:nowrap'},'保存设置');
    var tip=E('span',{'style':'font-size:12px;color:#64748b;display:inline-block;margin-left:8px'},
      hasConflict?'已有高级规则：请在高级设置中管理':(rules.length?'已保存到插件；运行效果需在「应用更改」中核验':'没有单独设置：按路由器默认方式上网'));
    function change(){
      var edited=select.value!==preset;
      btn.disabled=hasConflict||!edited;
      btn.textContent=edited?'保存这台设备':'无需保存';
      if(!hasConflict)tip.textContent=edited?'尚未保存；点击后只修改插件设置，不影响当前网络':(rules.length?'插件设置已保存；是否运行生效请查看「应用更改」':'没有单独设置：按默认方式上网');
    }
    select.addEventListener('change',change);
    btn.addEventListener('click',function(ev){ev.preventDefault();if(btn.disabled)return;assignDevice(ip,select.value);});
    change();
    return E('tr',{},[
      E('td',{},[E('div',{'style':'font-weight:600'},label),E('div',{'style':'font-size:12px;color:#64748b'},ip)]),
      E('td',{},hasConflict?'已有高级规则':rules.length?outletLabel(saved):'自动使用默认线路'),
      E('td',{},[select,' ',btn,tip])
    ]);
  }
  // V1.6: Save only the dualwan profile weights in WanPilot's own UCI config.
  // This does NOT alter mwan3's existing default balanced policy.
  var dualwanProfile=uci.sections('wanpilot','profile').find(function(p){return p.name==='dualwan' && p.mode==='balance' && p.primary==='wan' && p.secondary==='wan1';});
  var wp=parseInt(dualwanProfile && dualwanProfile.weight_primary || '1',10);
  var ws=parseInt(dualwanProfile && dualwanProfile.weight_secondary || '1',10);
  var currentPct=(wp>0&&ws>0)?Math.round(wp*100/(wp+ws)):50;
  var slider=E('input',{'type':'range','min':'5','max':'95','step':'5','value':String(Math.max(5,Math.min(95,Math.round(currentPct/5)*5))), 'style':'width:100%;max-width:540px'});
  var pctLabel=E('strong',{},'WAN '+slider.value+'% / WAN1 '+(100-Number(slider.value))+'%');
  slider.addEventListener('input',function(){pctLabel.textContent='WAN '+slider.value+'% / WAN1 '+(100-Number(slider.value))+'%';});
  var weightCard=E('div',{'class':'cbi-section','style':'border:1px solid #d7dce5;border-radius:10px;padding:16px;margin:12px 0'},[
    E('h3',{},'设备双线分担比例'),
    E('p',{},'仅调整 WanPilot 中 dualwan 策略模板的连接分流比例；不会直接修改 mwan3 默认 balanced 策略，也不会立刻改变实际线路分配。'),
    E('div',{},pctLabel), slider,
    E('div',{'id':'wp-weight-saved','style':'margin:8px 0 12px'},dualwanProfile?'当前已保存比例：WAN '+currentPct+'% / WAN1 '+(100-currentPct)+'%':'未识别到 dualwan 模板；点击保存将返回具体检查结果。'),
    E('div',{'id':'wp-weight-result','style':'white-space:pre-wrap;margin:8px 0;color:#344054'},''),
    E('button',{'class':'btn cbi-button-action','type':'button','click':ui.createHandlerFn(this,function(ev){
       if(ev && ev.preventDefault)ev.preventDefault();
       var p=Number(slider.value), output=viewNode('wp-weight-result');
       if(output)output.textContent='正在保存 WAN '+p+'% / WAN1 '+(100-p)+'%…';
       return fs.exec('/usr/libexec/wanpilot-weight',['save',String(p)]).then(function(result){
         var msg=((result.stdout||'')+'\n'+(result.stderr||'')).trim();
         if(result.code!==0){
           if(output)output.textContent='保存失败（退出码 '+result.code+'）：'+msg;
           ui.addNotification(null,E('p',{},'权重保存失败：'+msg),'danger');return;
         }
         if(output)output.textContent=msg+'。只保存 WanPilot 配置，未应用到 mwan3。';
         var saved=viewNode('wp-weight-saved');
         if(saved)saved.textContent='当前已保存比例：WAN '+p+'% / WAN1 '+(100-p)+'%';
         ui.addNotification(null,E('p',{},'权重已保存；未修改 mwan3。'),'info');
       }).catch(function(err){
          if(output)output.textContent='调用失败：'+String(err);
          ui.addNotification(null,E('p',{},'权重保存失败：'+String(err)),'danger');
       });
    })},'保存 dualwan 权重'),
    E('p',{'style':'font-size:12px;opacity:.75'},dualwanProfile?'权重保存成功后可先生成候选配置预览；仅显式应用后才可能影响匹配 dualwan 的设备。':'当前没有符合条件的 dualwan 负载均衡策略，请先在策略表中创建。')
  ]);
  // V1.7 global target is intentionally planning-only; it is never injected into mwan3.
  var desiredWan=Number(uci.get('wanpilot','main','global_wan_pct')||50);
  if(!Number.isFinite(desiredWan)||desiredWan<5||desiredWan>95)desiredWan=50;
  var globalSlider=E('input',{'type':'range','min':'5','max':'95','step':'5','value':String(desiredWan),'class':'wp124-ratio-slider','style':'width:100%;max-width:100%'});
  var globalValue=E('strong',{},'WAN '+desiredWan+'% / WAN1 '+(100-desiredWan)+'%');
  function wp124PaintRatioSlider(){ var pct=Number(globalSlider.value); globalSlider.style.background='linear-gradient(to right, var(--wp124-wan) 0%, var(--wp124-wan) '+pct+'%, var(--wp124-wan1) '+pct+'%, var(--wp124-wan1) 100%)'; }
  wp124PaintRatioSlider();
  globalSlider.addEventListener('input',function(){globalValue.textContent='WAN '+globalSlider.value+'% / WAN1 '+(100-Number(globalSlider.value))+'%';wp124PaintRatioSlider();});
  var globalResult=E('pre',{'style':'white-space:pre-wrap'},uci.get('wanpilot','main','global_wan_pct') ? '已保存的目标：WAN '+desiredWan+'% / WAN1 '+(100-desiredWan)+'%；此比例不等于当前生效比例。' : '尚未保存全局目标比例');
  // V4.8: the slider is an unsaved draft only. Never persist on render/input.
  var targetSaveBusy=false;
  var targetSaveButton=null;
  var targetDraftStatus=E('div',{'style':'font-size:12px;color:#475569;margin:8px 0'},'当前选择与已保存目标一致；尚未对网络执行任何操作。');
  function refreshTargetSaveState() {
    if (!targetSaveButton) return;
    var changed=Number(globalSlider.value)!==desiredWan;
    targetSaveButton.disabled=targetSaveBusy||!changed;
    targetSaveButton.textContent=targetSaveBusy?'正在核对并保存…':(changed?'保存目标比例（不立即生效）':'没有修改，无需保存');
    targetDraftStatus.textContent=targetSaveBusy?'正在核对路由器中的已保存目标…':(changed?'尚未保存的选择：WAN '+globalSlider.value+'% / WAN1 '+(100-Number(globalSlider.value))+'%。点击保存前不会写入配置。':'已保存目标：WAN '+desiredWan+'% / WAN1 '+(100-desiredWan)+'%。滑块没有未保存的修改。');
  }
  function readFreshTarget() {
    // Reuse the existing authorized read-only audit provider (not the cached LuCI UCI object).
    return fs.exec('/usr/libexec/wanpilot-v26-audit',[]).then(function(r){
      if(r.code!==0) throw new Error('实时检查失败（退出码 '+r.code+'），已停止保存。');
      var m=String(r.stdout||'').match(/^TARGET WAN=(\d+)% WAN1=(\d+)%/m);
      if(!m||Number(m[1])+Number(m[2])!==100) throw new Error('无法读取已保存比例，已停止保存。');
      return Number(m[1]);
    });
  }
  var hitResult=E('pre',{'style':'white-space:pre-wrap;max-height:280px;overflow:auto'},'点击下方按钮读取设备规则匹配计数。');
  var globalPreviewResult=E('pre',{'style':'white-space:pre-wrap'},'尚未运行全局预览');
  var globalSafeResult=E('pre',{'style':'white-space:pre-wrap'},'尚未运行全局安全就绪检查');
  var globalControlResult=E('pre',{'style':'white-space:pre-wrap'},'尚未执行全局操作');
  var v17Card=E('div',{'class':'cbi-section','style':'border:1px solid #d7dce5;border-radius:10px;padding:16px;margin:12px 0'},[
    E('h3',{},'普通设备的流量分担'),
    E('p',{},'在这里调整准备使用的比例。下方显示已保存目标，不代表当前网络已经采用；当前生效比例请到「应用更改」查看。'),
    globalValue,globalSlider,targetDraftStatus,
    (targetSaveButton=E('button',{'class':'btn cbi-button-action','type':'button','click':ui.createHandlerFn(this,function(ev){
      if(ev&&ev.preventDefault)ev.preventDefault();
      if(targetSaveBusy)return Promise.resolve();
      var draft=Number(globalSlider.value);
      if(draft===desiredWan){refreshTargetSaveState();return Promise.resolve();}
      targetSaveBusy=true;refreshTargetSaveState();
      return readFreshTarget().then(function(fresh){
        if(fresh!==desiredWan){
          // Never silently replace a target written in a different tab or session.
          desiredWan=fresh;globalResult.textContent='已停止保存：其他页面或操作已更改目标比例。最新目标 WAN '+fresh+'% / WAN1 '+(100-fresh)+'%。请核对后再决定是否保存。';
          return;
        }
        if(!window.confirm('确认只保存目标比例：WAN '+draft+'% / WAN1 '+(100-draft)+'%？\n\n原已保存：WAN '+fresh+'% / WAN1 '+(100-fresh)+'%。\n此操作不会让路由器立即采用新比例。'))return;
        return fs.exec('/usr/libexec/wanpilot-v17',['save-target',String(draft)]).then(function(res){
          if(res.code!==0)throw new Error('保存失败（退出码 '+res.code+'）：'+(res.stderr||res.stdout||''));
          desiredWan=draft;
          globalResult.textContent='已保存目标比例：WAN '+draft+'% / WAN1 '+(100-draft)+'%。当前运行线路未修改。\n'+(res.stdout||'');
        });
      }).catch(function(err){globalResult.textContent='没有保存任何新目标：'+String(err);})
      .then(function(){targetSaveBusy=false;refreshTargetSaveState();});
    })},'保存目标比例（不立即生效）')),globalResult,
    E('h3',{},'全局候选配置预览（只读）'),
    E('p',{},'请先保存目标比例，再点击预览。预览会在临时目录生成配置，不会修改真实 mwan3。'),
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){
      return fs.exec('/usr/libexec/wanpilot-global-preview',[]).then(function(res){globalPreviewResult.textContent='退出码 '+res.code+'\n'+(res.stdout||'')+'\n'+(res.stderr||'');}).catch(function(e){globalPreviewResult.textContent='预览失败：'+String(e);});
    })},'生成全局 balanced 候选配置（不应用）'),
    globalPreviewResult,
    E('button', {'class':'btn cbi-button', 'click':ui.createHandlerFn(this,function(){
      return fs.exec('/usr/libexec/wanpilot-global-safe',['check']).then(function(res){
        globalSafeResult.textContent='退出码 '+res.code+'\n'+(res.stdout||'')+'\n'+(res.stderr||'');
      }).catch(function(e){globalSafeResult.textContent='全局安全检查失败：'+String(e);});
    })}, '全局安全就绪检查（只读）'),
    globalSafeResult,
    E('h3',{},'流量分担 · 应用与恢复'),
    E('p',{},'全局操作独立于设备分流应用器。应用前检查会验证配置快照；应用后约 120 秒内需要确认，否则后台尝试回滚。全局和设备待确认任务不能并行。'),
    E('div',{'id':'wp-v20-global-state'},'正在读取全局安全状态…'),
    E('div',{'id':'wp-v21-global-countdown','style':'font-weight:600;margin:8px 0;color:#b45309'},''),
    E('button',{'class':'btn cbi-button-positive','id':'wp-v20-global-apply','click':ui.createHandlerFn(this,function(){
      if(!wpUnifiedReady || wpUnifiedDevicePending || wpUnifiedGlobalPending){ui.addNotification(null,E('p',{},'安全状态未知或存在待确认任务，请先刷新统一状态。'),'danger');return Promise.resolve();}
      if(!window.confirm('将修改真实全局 balanced 并重启 mwan3。此操作可能短暂断网，约 120 秒内不确认将自动恢复。确认已在本地局域网并准备执行？'))return Promise.resolve();
      var applyBtn=viewNode('wp-v20-global-apply');
      if(applyBtn)applyBtn.disabled=true;
      return fs.exec('/usr/libexec/wanpilot-global-safe',['check']).then(function(r){
        globalControlResult.textContent='就绪检查退出码 '+r.code+'\n'+(r.stdout||'')+'\n'+(r.stderr||'');
        if(r.code!==0)return;
        return wpCaptureBeforeApply('global-pre-apply').then(function(){return fs.exec('/usr/libexec/wanpilot-global-safe',['apply']);}).then(function(a){
          globalControlResult.textContent='应用退出码 '+a.code+'\n'+(a.stdout||'')+'\n'+(a.stderr||'');
          if(a.code===0 && /PENDING:/.test(a.stdout||'')){globalApplyObservedAt=Date.now();globalLastPending=true;var el=viewNode('wp-v20-global-state');if(el)el.textContent='全局状态：等待确认（后台自动回滚已启动）';drawGlobalCountdown();}
          return Promise.all([refreshGlobalState(true),refreshUnifiedState()]).then(function(){
            if(a.code===0) return wpRetainAfterSuccessfulApply('global').then(function(){return Promise.all([refreshGlobalState(true),refreshUnifiedState()]);});
          });
        });
      }).catch(function(e){globalControlResult.textContent='全局应用错误：'+String(e);return refreshGlobalState();}).finally(function(){return refreshUnifiedState();});
    })},'应用流量分担比例'), ' ',
    E('button',{'class':'btn cbi-button-action','id':'wp-v20-global-confirm','disabled':true,'click':ui.createHandlerFn(this,function(){
      if(!window.confirm('确定保留新的全局 balanced 配置，并停止本次回滚？'))return Promise.resolve();
      return fs.exec('/usr/libexec/wanpilot-global-safe',['confirm']).then(function(r){globalControlResult.textContent='确认退出码 '+r.code+'\n'+(r.stdout||'')+'\n'+(r.stderr||'');return Promise.all([refreshGlobalState(true),refreshUnifiedState()]);}).catch(function(e){globalControlResult.textContent=String(e);return Promise.all([refreshGlobalState(true),refreshUnifiedState()]);});
    })},'保留新的分担比例'), ' ',
    E('button',{'class':'btn cbi-button-negative','id':'wp-v20-global-rollback','disabled':true,'click':ui.createHandlerFn(this,function(){
      if(!window.confirm('确认立即恢复应用前的全局 mwan3 配置？'))return Promise.resolve();
      return fs.exec('/usr/libexec/wanpilot-global-safe',['rollback']).then(function(r){globalControlResult.textContent='回滚退出码 '+r.code+'\n'+(r.stdout||'')+'\n'+(r.stderr||'');return Promise.all([refreshGlobalState(true),refreshUnifiedState()]);}).catch(function(e){globalControlResult.textContent=String(e);return Promise.all([refreshGlobalState(true),refreshUnifiedState()]);});
    })},'恢复应用前比例'),
    globalControlResult,

    E('h3',{},'设备分流规则命中诊断'),
    E('p',{},'统计 mwan3 规则计数器的包数和字节数，不代表某设备真实公网 IP；计数可能随服务重启清零。'),
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){
      return fs.exec('/usr/libexec/wanpilot-v17',['hits']).then(function(res){hitResult.textContent='退出码 '+res.code+'\n'+(res.stdout||'')+'\n'+(res.stderr||'');}).catch(function(e){hitResult.textContent=String(e);});
    })},'读取设备规则命中计数（只读）'),hitResult
  ]);
  // Overview only contains the live WAN monitor. Device inventory lives in device routing.
  var summary=E('div',{'class':'cbi-section'},[]);
  // V3.2: read-only live monitor. Reuse the verified snapshot interface;
  // interface traffic is NOT per-policy throughput or public IP evidence.
  var liveMonitorRows={};
  var liveMonitorStatus=E('div',{'class':'wp123-overview-refresh'},'等待首次采样…');
  var liveMonitorCards=E('div',{'class':'wp123-line-grid'},[]);
  ['wan','wan1'].forEach(function(name){
    var link=E('div',{'style':'font-weight:600;margin:4px 0'},'正在读取…');
    var speed=E('div',{'style':'font-size:14px;margin:6px 0'},'下载 — / 上传 —');
    var detail=E('div',{'style':'font-size:12px;color:#64748b'},'接口信息：待获取');
    var totals=E('div',{'style':'font-size:12px;color:#64748b;margin-top:4px'},'累计流量：待获取');
    var latency=E('div',{'style':'font-size:12px;color:#64748b;margin-top:4px'},'延迟：未检测');
    var spark=E('div',{'style':'margin-top:8px;display:flex;align-items:flex-end;gap:2px;height:38px'},[]);
    var trendNote=E('div',{'style':'font-size:11px;color:#64748b;margin-top:4px'},'正在采集最近的流量变化…');
    for(var i=0;i<24;i++)spark.appendChild(E('div',{'style':'flex:1;height:2px;background:#cbd5e1;border-radius:2px'}));
    liveMonitorRows[name]={link:link,speed:speed,detail:detail,totals:totals,latency:latency,spark:spark,trendNote:trendNote,history:[]};
    liveMonitorCards.appendChild(E('div',{'class':'wp123-line-card wp124-line-'+name},[
      E('div',{'class':'wp123-line-head'},[
        E('div',{},[E('div',{'class':'wp123-line-label'},name==='wan'?'主线路':'第二线路'),E('div',{'class':'wp123-line-name'},name.toUpperCase())]),
        link
      ]),
      E('div',{'class':'wp123-speed'},[speed]),
      E('div',{'class':'wp123-meta'},[detail,latency,totals]),
      E('div',{'class':'wp123-trend'},[spark,trendNote])
    ]));
  });
  var monitorCard=E('div',{'class':'cbi-section wp123-overview-card'},[
    E('div',{'class':'wp123-overview-head'},[
      E('div',{},[E('div',{'class':'wp123-eyebrow'},'LIVE STATUS'),E('h3',{},'双 WAN 运行状态'),E('p',{},'查看两条线路的在线状态、实时流量变化和接口信息。')]),
      liveMonitorStatus
    ]),
    liveMonitorCards,
    E('div',{'class':'wp123-overview-foot'},'约每 5 秒刷新一次接口流量；显示的是路由器接口实时速率，不是宽带测速结果。')
  ]);
  // Display live WAN status without creating or deleting duplicate cards.
  summary.appendChild(monitorCard);
  var deviceRuleCells=[];
  var deviceRuntimeStatus=E('div',{'style':'font-size:13px;color:#475569'},'规则状态：尚未查询运行命中（只读）');
  var deviceRuntimeResult=E('pre',{'style':'white-space:pre-wrap;max-height:210px;overflow:auto;font-size:12px;margin-top:8px'},'尚未读取规则命中信息');
  var deviceRuntimeBox=E('div',{'class':'cbi-section','style':'border:1px solid #d7dce5;border-radius:10px;padding:14px;margin:10px 0'},[
    E('h3',{'style':'margin-top:0'},'设备分流状态（只读）'),
    E('p',{'style':'color:#64748b;font-size:12px'},'显示已保存的设备定向规则及其目标策略；命中计数来自 mwan3 规则统计，不能证明设备真实公网出口。'),
    E('div',{'style':'max-height:220px;overflow:auto'},E('table',{'class':'table'},[
      E('tr',{},['设备 / 地址','目标策略','配置状态','运行命中'].map(function(t){return E('th',{},t);})),
    ].concat(uci.sections('wanpilot','rule').filter(function(v){return v.src_ip||v.device_ip;}).map(function(v){
      var ip=v.src_ip||v.device_ip||'—';var lease=leaseRows.filter(function(d){return ip===d[0]||ip===d[0]+'/32';})[0];
      var hitCell=E('td',{'style':'font-size:12px;white-space:nowrap'},'未查询');
      deviceRuleCells.push({ip:ip.replace(/\/32$/,''),target:v.profile||'',cell:hitCell,enabled:v.enabled!=='0'});
      return E('tr',{},[
        E('td',{},(lease&&lease[2]&&lease[2]!=='*'?lease[2]+' · ':'')+ip),
        E('td',{},v.profile||'未指定'),
        E('td',{},v.enabled==='0'?'已禁用':'已保存（生效需核验）'),
        hitCell
      ]);
    }).concat(uci.sections('wanpilot','rule').some(function(v){return v.src_ip||v.device_ip;})?[]:[E('tr',{},E('td',{'colspan':'4'},'尚无设备定向规则'))])))
    ),
    deviceRuntimeStatus,
    E('button',{'type':'button','class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return loadRuntimeHits();})},'刷新运行命中（只读）'),
    E('details',{'style':'margin-top:8px'},[E('summary',{'style':'cursor:pointer'},'查看原始规则计数'),deviceRuntimeResult])
  ]);
  function loadRuntimeHits(){
    deviceRuntimeStatus.textContent='正在读取 mwan3 规则计数…';
    return fs.exec('/usr/libexec/wanpilot-v17',['hits']).then(function(r){
      var hitErr=(r.stderr||'').trim();
      var onlyPipeWarning=/^cut: standard output: Broken pipe$/.test(hitErr);
      var warningsRemoved=onlyPipeWarning && r.code===0;
      deviceRuntimeResult.textContent=(r.stdout||'')+(hitErr?'\n[后端原始提示] '+hitErr:'');
      if(r.code!==0){
        deviceRuleCells.forEach(function(item){item.cell.textContent='读取失败';});
        deviceRuntimeStatus.textContent='命中读取失败（退出码 '+r.code+'），请展开详情。';
        return;
      }
      var records=[];
      (r.stdout||'').split(/\r?\n/).forEach(function(line){
        var src=line.match(/\bsrc=(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?(?:\s|$)/);
        var packets=line.match(/\bpackets=(\d+)/), count=line.match(/\bbytes=(\d+)/);
        if(src&&packets&&count)records.push({ip:src[1],packets:Number(packets[1]),bytes:Number(count[1]),policy:(line.match(/\bpolicy=([^\s]+)/)||[])[1]||''});
      });
      var found=0;
      deviceRuleCells.forEach(function(item){
        if(!item.enabled){item.cell.textContent='已禁用';return;}
        var expectedPolicy='wpx_p_'+item.target;
        var matched=records.filter(function(rec){return rec.ip===item.ip && rec.policy===expectedPolicy;});
        if(!matched.length){item.cell.textContent='未发现对应策略计数';return;}
        var pkts=0,total=0;
        matched.forEach(function(rec){pkts+=rec.packets;total+=rec.bytes;});
        item.cell.textContent=pkts+' 包 · '+bytes(total)+'（匹配统计）';
        found++;
      });
      deviceRuntimeStatus.textContent='运行命中：'+found+'/'+deviceRuleCells.length+' 条设备规则匹配到来源 IP 与目标策略。'+(warningsRemoved?'（计数已成功读取；非致命管道提示在原始详情中）':hitErr?'（后端存在诊断输出，请查看原始详情）':'')+' 计数可在 mwan3 重启后归零，不代表实际公网出口。';
    }).catch(function(e){deviceRuntimeStatus.textContent='无法获取运行计数：'+String(e);});
  }
  // Only report what mwan3 actually exposes; no active connectivity probes.
  var routeNote=E('div',{'style':'font-size:12px;color:#64748b;margin-top:8px'},'线路健康状态来自 mwan3 快照；策略命中和线路在线均不能单独证明设备的公网出口。故障切换测试不自动断开任何线路。');
  deviceRuntimeBox.appendChild(routeNote);
  summary.insertBefore(deviceRuntimeBox,summary.children[1] || null);
  var actions=E('div',{'class':'cbi-section'},[
    E('h3',{},'操作与诊断'),
    E('div',{'style':'border:1px solid #cad3e0;border-radius:8px;padding:14px;margin:12px 0;background:#f7f9fc;color:#27324e'},[
      E('h4',{},'当前应用保护状态（只读）'),
      E('p',{},'状态由设备应用器与全局应用器分别读取；如状态读取失败，网页禁止发起新的应用。'),
      E('div',{'id':'wp-v22-device-status'},'设备分流：正在读取…'),
      E('div',{'id':'wp-v22-global-status'},'全局均衡：正在读取…'),
      E('div',{'id':'wp-v22-advice','style':'margin-top:8px;font-weight:600'},'正在检查应用互斥状态…'),
      E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return refreshUnifiedState();})},'刷新统一状态（只读）')
    ]),
    E('p',{},'当前适配：iStoreOS 22.03.7 / x86_64；wan + wan1 双线。默认保持 50/50，原 router_local 与 fix1~fix4 规则优先。'),
    E('p',{},'请先使用页面底部的“保存并应用”保存 WanPilot 表单。它只保存本插件配置，不会自动重写 mwan3。'),
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot',['validate']).then(show);})},'验证配置'), ' ',
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot',['preview']).then(show);})},'预览策略'), ' ',
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot',['preflight']).then(show);})},'应用前安全检查（只读）'), ' ',
    E('button',{'class':'btn cbi-button-action','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot-stage',[]).then(show).catch(function(err){ var p=viewNode('wanpilot-result'); if (p) p.textContent='候选配置生成失败：'+String(err); ui.addNotification(null,E('p',{},'候选配置生成失败，请检查授权或查看下方详细错误。'),'danger'); });})},'生成通用策略候选配置（不应用）'), ' ',
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot-safe',['check']).then(show).catch(function(err){var p=viewNode('wanpilot-result');if(p)p.textContent='安全检查失败：'+String(err);});})},'检查设备更改是否可以安全应用'), ' ',
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot-safe',['status']).then(show);})},'设备回滚引擎状态'), ' ',
    E('div',{'style':'border:1px solid #d4b36a;border-radius:8px;padding:12px;margin:12px 0'},[
      E('h4',{},'设备线路 · 应用与恢复（120 秒保护）'),
      E('p',{},'请先保存所有 WanPilot 表单修改，再执行就绪检查。应用操作会重启 mwan3，可能短暂断网；本功能仅建议通过局域网操作。'),
      E('div',{'id':'wp-v14-state'},'正在读取安全引擎状态…'),
      E('div',{'id':'wp-v15-countdown','style':'font-size:22px;font-weight:600;margin:8px 0;display:none'},''),
      E('button',{'class':'btn cbi-button-positive','id':'wp-v14-apply','click':ui.createHandlerFn(this,function(){
        if (!wpUnifiedReady || wpUnifiedGlobalPending || wpUnifiedDevicePending) {ui.addNotification(null,E('p',{},'安全状态未知或存在待确认任务，请先刷新统一状态。'),'danger');return Promise.resolve();}
        if (!window.confirm('即将修改真实 mwan3 并重启服务；未确认将在约 120 秒后自动恢复。请确认已保存配置且当前通过局域网管理。是否继续？')) return Promise.resolve();
        var applyBtn=viewNode('wp-v14-apply');
        if(applyBtn)applyBtn.disabled=true;
        return fs.exec('/usr/libexec/wanpilot-safe',['check']).then(function(res){
          show(res);
          if(res.code!==0){ ui.addNotification(null,E('p',{},'安全就绪检查未通过：没有执行实际应用。'),'danger'); return; }
          return wpCaptureBeforeApply('device-pre-apply').then(function(){return fs.exec('/usr/libexec/wanpilot-safe',['apply']);}).then(function(out){show(out);return Promise.all([refreshSafety(true),refreshUnifiedState()]).then(function(){if(out.code!==0)ui.addNotification(null,E('p',{},'应用执行失败，请检查状态及回滚日志。'),'danger');else return wpRetainAfterSuccessfulApply('device').then(function(){return Promise.all([refreshSafety(true),refreshUnifiedState()]);});});}).catch(function(err){ui.addNotification(null,E('p',{},'应用请求失败：'+String(err)),'danger');return refreshSafety(true);});
        }).catch(function(err){ui.addNotification(null,E('p',{},'就绪检查执行失败：'+String(err)),'danger');}).finally(function(){return refreshUnifiedState();});
      })},'应用设备线路设置'), ' ',
      E('button',{'class':'btn cbi-button-action','id':'wp-v14-confirm','click':ui.createHandlerFn(this,function(){
        if(!window.confirm('确认保留当前已应用的 mwan3 配置，并取消本次自动回滚？'))return Promise.resolve();
        return fs.exec('/usr/libexec/wanpilot-safe',['confirm']).then(function(res){show(res);refreshSafety();}).catch(function(err){ui.addNotification(null,E('p',{},String(err)),'danger');refreshSafety();});
      })},'确认保留本次更改'), ' ',
      E('button',{'class':'btn cbi-button-negative','id':'wp-v14-rollback','click':ui.createHandlerFn(this,function(){
        if(!window.confirm('现在将恢复应用前的 mwan3 配置并重启 mwan3。确认手动回滚？'))return Promise.resolve();
        return fs.exec('/usr/libexec/wanpilot-safe',['rollback']).then(function(res){show(res);refreshSafety();}).catch(function(err){ui.addNotification(null,E('p',{},String(err)),'danger');refreshSafety();});
      })},'恢复到更改之前')
    ]),
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot',['runtime-audit']).then(show);})},'核验设备规则运行状态（只读）'), ' ',
    E('button',{'class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return fs.exec('/usr/libexec/wanpilot',['status']).then(show);})},'查看线路状态'),
    E('div',{'id':'wp-apply-state'},'应用保护状态：'+((data[4]&&data[4].stdout)||'读取中…')),
    E('pre',{'id':'wanpilot-result','style':'white-space:pre-wrap;max-height:400px;overflow:auto'},'尚未运行诊断')
  ]);
  function show(res){var p=viewNode('wanpilot-result');if(p)p.textContent='退出码: '+res.code+'\n'+(res.stdout||'')+'\n'+(res.stderr||'');}
  var v14Busy=false;
  var wpUnifiedReady=false, wpUnifiedDevicePending=false, wpUnifiedGlobalPending=false;
  var v15Deadline=0;
  var v15Pending=false;
  function drawCountdown(){
    var el=viewNode('wp-v15-countdown'); if(!el)return;
    el.style.display=v15Pending ? 'block' : 'none';
    if(v15Pending){
      if(v15Deadline>0){
        var left=Math.max(0,Math.ceil(v15Deadline-Date.now()/1000));
        el.textContent=left>0 ? '预计剩余 ' + left + ' 秒（服务器定时）' : '预计到期，正在核对后台恢复状态…';
      } else el.textContent='等待后台确认保护时间…';
    }
  }
  function refreshSafety(force){
    if(v14Busy && !force)return Promise.resolve();
    v14Busy=true;
    return fs.exec('/usr/libexec/wanpilot-ui-status',[]).then(function(res){
      if(res.code!==0)throw Error((res.stderr||res.stdout||'状态程序错误'));
      var body=res.stdout||'';
      var val=function(key){var m=body.match(new RegExp('^'+key+'=(.*)$','m'));return m?m[1].trim():'';};
      var status=val('state')||'unknown', pending=val('pending')==='yes';
      var map={never_started:'尚未应用',restored:'已恢复原配置',confirmed:'已确认生效',pending:'等待确认',arming:'正在启动回滚保护',arming_failed:'保护启动失败',pending_restart_failed:'服务重启异常，等待恢复',restore_failed_service_or_hash:'恢复异常，请检查日志',restore_failed_backup:'备份缺失',restore_failed_backup_hash:'备份校验失败',arming_cancelled_source_changed:'规则变更，应用已取消'};
      var label=viewNode('wp-v14-state');
      v15Pending=pending;
      var deadline=Number(val('deadline_epoch'));
      v15Deadline=Number.isFinite(deadline)&&deadline>0?deadline:0;
      if(label)label.textContent='状态：'+(map[status]||status)+'；'+(pending?'当前配置待确认，超时后后台将尝试恢复。':'当前没有等待确认的策略。');
      ['wp-v14-confirm','wp-v14-rollback'].forEach(function(id){var b=viewNode(id);if(b)b.disabled=!pending;});
      var apply=viewNode('wp-v14-apply');if(apply)apply.disabled=pending || !wpUnifiedReady || wpUnifiedGlobalPending;
      drawCountdown();
    }).catch(function(err){
      var label=viewNode('wp-v14-state');if(label)label.textContent='状态读取失败：'+String(err);
      v15Pending=false;drawCountdown();
    }).then(function(){v14Busy=false;});
  }

  var globalPollBusy=false, globalPollVersion=0, globalApplyObservedAt=0, globalLastPending=false;
  function drawGlobalCountdown(){
    var el=viewNode('wp-v21-global-countdown');if(!el)return;
    if(!globalLastPending){el.textContent='';return;}
    if(!globalApplyObservedAt){el.textContent='配置待确认；后台最多约 120 秒后尝试回滚。请尽快确认。';return;}
    var elapsed=Math.max(0,Math.floor((Date.now()-globalApplyObservedAt)/1000));
    var upper=Math.max(0,120-elapsed);
    el.textContent=upper>0?'从页面收到成功响应起估算：不超过 '+upper+' 秒（实际时间可能更短）':'预计保护期已到；等待后台状态确认，请勿重复应用。';
  }
  function refreshGlobalState(force){
    if(globalPollBusy && !force)return Promise.resolve();
    var ticket=++globalPollVersion;
    globalPollBusy=true;
    return Promise.all([
      fs.exec('/usr/libexec/wanpilot-global-safe',['status']),
      fs.exec('/usr/libexec/wanpilot-safe',['status'])
    ]).then(function(results){
      function field(s,k){var m=(s||'').match(new RegExp('^'+k+'=(.*)$','m'));return m?m[1].trim():'';}
      if(ticket!==globalPollVersion)return;
      var g=results[0], d=results[1], gs=g.stdout||'', ds=d.stdout||'';
      if(g.code!==0||d.code!==0)throw Error('状态程序返回非零退出码');
      var s=field(gs,'state')||'never_started', gp=field(gs,'pending')==='yes', dp=field(ds,'pending')==='yes';
      var translations={never_started:'尚未应用',pending:'待确认',confirmed:'已确认生效',restored:'已恢复原配置',arming:'正在启动保护',pending_restart_failed:'重启异常，等待恢复',restore_failed_service_or_hash:'恢复异常，请检查 SSH 日志'};
      globalLastPending=gp;
      if(!gp)globalApplyObservedAt=0;
      drawGlobalCountdown();
      var el=viewNode('wp-v20-global-state');
      if(el)el.textContent='全局状态：'+(translations[s]||s)+(gp?'（等待确认，后台限时回滚）':'（无待确认全局任务）')+(dp?'；设备应用任务正在等待确认':'');
      var a=viewNode('wp-v20-global-apply'),c=viewNode('wp-v20-global-confirm'),r=viewNode('wp-v20-global-rollback');
      if(a)a.disabled=gp||dp||!wpUnifiedReady;
      if(c)c.disabled=!gp;
      if(r)r.disabled=!gp;
    }).catch(function(err){
      if(ticket!==globalPollVersion)return;
      var el=viewNode('wp-v20-global-state');if(el)el.textContent='全局状态读取失败：'+String(err);
      ['wp-v20-global-apply','wp-v20-global-confirm','wp-v20-global-rollback'].forEach(function(id){var b=viewNode(id);if(b)b.disabled=true;});
    }).then(function(){if(ticket===globalPollVersion)globalPollBusy=false;});
  }

  function refreshUnifiedState(){
    wpUnifiedReady=false;
    var da=viewNode('wp-v14-apply'), ga=viewNode('wp-v20-global-apply');
    if(da)da.disabled=true;
    if(ga)ga.disabled=true;
    function field(txt,key){var m=(txt||'').match(new RegExp('^'+key+'=(.*)$','m'));return m?m[1].trim():'';}
    var translations={never_started:'尚未应用',pending:'待确认',confirmed:'已确认生效',restored:'已恢复原配置',arming:'正在启动保护',pending_restart_failed:'服务重启异常',restore_failed_service_or_hash:'恢复异常'};
    return Promise.all([fs.exec('/usr/libexec/wanpilot-safe',['status']),fs.exec('/usr/libexec/wanpilot-global-safe',['status'])]).then(function(result){
      if(result[0].code!==0||result[1].code!==0)throw Error('安全状态后端返回非零退出码');
      var d=result[0].stdout||'',g=result[1].stdout||'';
      var ds=field(d,'state'),gs=field(g,'state');
      var dp=field(d,'pending')==='yes',gp=field(g,'pending')==='yes';
      if(!ds||!gs||!['yes','no'].includes(field(d,'pending'))||!['yes','no'].includes(field(g,'pending')))throw Error('安全状态字段缺失');
      wpUnifiedDevicePending=dp;wpUnifiedGlobalPending=gp;
      var de=viewNode('wp-v22-device-status'),ge=viewNode('wp-v22-global-status'),ad=viewNode('wp-v22-advice');
      if(de)de.textContent='设备策略：'+(translations[ds]||ds)+(dp?'（等待确认）':'');
      if(ge)ge.textContent='全局策略：'+(translations[gs]||gs)+(gp?'（等待确认）':'');
      if(ad)ad.textContent=dp||gp?'存在待确认任务，禁止启动另一项应用。':'当前无待确认任务；仍须在应用前进行后台安全检查。';
      wpUnifiedReady=true;
      if(da)da.disabled=dp||gp;
      if(ga)ga.disabled=dp||gp;
    }).catch(function(err){
      var ad=viewNode('wp-v22-advice');if(ad)ad.textContent='状态检查失败：'+String(err)+'；已禁用新应用操作。';
      wpUnifiedReady=false;
      if(da)da.disabled=true;
      if(ga)ga.disabled=true;
    });
  }

  var prior = {};
  var monitorActive = true;
  var poll = function() {
    // A detached view must not update UI, but initial mounting may still be pending.
    if (!monitorActive || !root || !root.isConnected) return Promise.resolve();
    return fs.exec('/usr/libexec/wanpilot',['snapshot']).then(function(out){
      if (!root || !root.isConnected) return;
      if (out.code !== 0) {liveMonitorStatus.textContent='线路快照读取失败（退出码 '+out.code+'），实时数据不可用。';return;}
      var now=Date.now();
      var liveRows=parseRows(out.stdout);
      var seen={};
      liveRows.forEach(function(w){
        if(!liveMonitorRows[w[0]])return;
        seen[w[0]]=true;
        var row=liveMonitorRows[w[0]];
        var online=w[1]==='online';
        row.link.textContent=online?'● mwan3 在线':(w[1]==='offline'?'○ mwan3 离线':'状态：'+(w[1]||'未知'));
        row.link.style.color=online?'#15803d':'#b45309';
        row.detail.textContent='接口：'+(w[2]||'未知')+' · IPv4：'+(w[3]||'未知')+(w[3]&&/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(w[3])?'（私有地址，非公网出口）':'');
        row.totals.textContent='累计下载 '+bytes(safeInt(w[4]))+' · 累计上传 '+bytes(safeInt(w[5]));
        // Optional measured latency from snapshot; never invent a ping value.
        var ms = w.length > 6 && /^\d+(?:\.\d+)?$/.test((w[6] || '').trim()) ? Number(w[6]) : null;
        row.latency.textContent='延迟：'+(ms !== null && Number.isFinite(ms) ? ms.toFixed(1)+' ms' : '未检测');
        var rx=safeInt(w[4]),tx=safeInt(w[5]),old=prior[w[0]];
        if(old && now>old.t && rx>=old.rx && tx>=old.tx){
          var period=(now-old.t)/1000;
          var down=(rx-old.rx)/period,up=(tx-old.tx)/period;
          row.speed.textContent='↓ '+bitrate(down)+'   ↑ '+bitrate(up);
          row.history.push({down:down,up:up});if(row.history.length>24)row.history.shift();
          var max=Math.max(1024,Math.max.apply(null,row.history.map(function(p){return Math.max(p.down,p.up);}))); 
          Array.prototype.forEach.call(row.spark.children,function(bar,i){
            var p=row.history[i-(24-row.history.length)];
            bar.style.height=p?Math.max(2,Math.round(36*Math.max(p.down,p.up)/max))+'px':'2px';
            bar.style.background=p?(p.down>=p.up?'#667eea':'#0d9488'):'#cbd5e1';
          });
          row.trendNote.textContent='最近 '+row.history.length+' 次采样 · 柱高表示相对本线路峰值';
        }else {row.speed.textContent='下载 — / 上传 —（等待连续采样）';row.history=[];Array.prototype.forEach.call(row.spark.children,function(b){b.style.height='2px';b.style.background='#cbd5e1';});row.trendNote.textContent='计数重置或首次采样，趋势重新开始';}
      });
      ['wan','wan1'].forEach(function(n){if(!seen[n]){var x=liveMonitorRows[n];x.link.textContent='状态不可用';x.link.style.color='#b45309';x.speed.textContent='暂无有效数据';x.detail.textContent='快照缺少该线路';x.totals.textContent='累计流量不可用';x.latency.textContent='延迟：未检测';x.history=[];}});
      liveMonitorStatus.textContent='最近采样：'+new Date(now).toLocaleTimeString()+' · 数据来源：wanpilot snapshot';
      liveRows.forEach(function(w){
        // V3.3.1: the legacy speed node was removed when overview cards were merged.
        // Always update the sampling baseline, even when that legacy node is absent.
        var el=viewNode('wp-speed-'+w[0]);
        var rx=safeInt(w[4]), tx=safeInt(w[5]), old=prior[w[0]];
        if (el && old && now>old.t && rx>=old.rx && tx>=old.tx) {
          var seconds=(now-old.t)/1000;
          el.textContent='实时下载：'+bitrate((rx-old.rx)/seconds)+'  |  上传：'+bitrate((tx-old.tx)/seconds);
        }
        prior[w[0]]={rx:rx,tx:tx,t:now};
      });
    }).catch(function(err){if(root.isConnected)liveMonitorStatus.textContent='线路快照读取异常：'+String(err);});
    fs.exec('/usr/libexec/wanpilot',['operation-state']).then(function(out){
      var el=viewNode('wp-apply-state'); if (!el) return;
      var state=(out.stdout||'').trim().split('|');
      el.textContent=state[0]==='pending' ? '⚠ 配置待确认，约 '+state[1]+' 秒后自动恢复原配置。' : '应用保护状态：没有待确认的策略';
    }).catch(function(){});
  };
  return m.render().then(function(node){
    // V4.6: use existing save handler; only disable duplicate save when target is unchanged.
    globalSlider.addEventListener('input',refreshTargetSaveState);
    refreshTargetSaveState();
    // V2.3: navigation only. Reuse original operational elements and handlers.
    // All panels stay mounted so existing status polling remains functional.
    // V4.1: one compact DHCP device list, advanced dual-WAN weights folded away.
    // Reuse the existing already-rendered DHCP list, preserving its event listeners.
    // V4.2: merge rule-only devices and DHCP leases into one deduplicated inventory.
    // No writes occur while rendering/filtering/sorting this table.
    var inventory = {};
    leaseRows.forEach(function(d) { if (/^\d+\.\d+\.\d+\.\d+$/.test(d[0]||'')) inventory[d[0]]=d; });
    uci.sections('wanpilot','rule').forEach(function(r) {
      var ip=(r.src_ip||r.device_ip||'').replace(/\/32$/,'');
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && !inventory[ip])
        inventory[ip]=[ip,'','*'];
    });
    var entries=Object.keys(inventory).map(function(ip){return inventory[ip];});
    // Named devices always come first. The backend already actively tries the
    // local DNS hostname for unnamed devices and learns successful results by MAC.
    // Within each group, sort by numeric IPv4 address for a stable, predictable list.
    function wpDeviceDisplayName(d){
      return (d[2]&&d[2]!=='*')?d[2]:(d[0]==='192.168.188.109'?'OPPO-Find-N3':'未命名设备');
    }
    function wpIpv4Number(ip){
      var x=String(ip||'').split('.').map(Number);
      return x.length===4?(((x[0]*256+x[1])*256+x[2])*256+x[3]):Number.MAX_SAFE_INTEGER;
    }
    entries.sort(function(a,b){
      var an=wpDeviceDisplayName(a)!=='未命名设备',bn=wpDeviceDisplayName(b)!=='未命名设备';
      if(an!==bn)return an?-1:1;
      return wpIpv4Number(a[0])-wpIpv4Number(b[0]);
    });
    var deviceSearch=E('input',{'type':'search','class':'cbi-input-text','placeholder':'搜索设备名称或 IP','style':'width:100%;max-width:300px;min-height:34px'});
    var deviceFilter=E('select',{'class':'cbi-input-select','style':'min-width:155px'},[
      E('option',{'value':'all'},'全部设备'),
      E('option',{'value':'configured'},'已单独设置'),
      E('option',{'value':'default'},'使用默认线路'),
      E('option',{'value':'edited'},'尚未保存的修改')
    ]);
    // V6.1: retain existing per-device select/save elements and their listeners.
    // Present rows as collapsed cards; opening a card never writes configuration.
    // The per-device selects are not persisted until their original save handlers run.
    // Detect unsaved edits before either publish path; never publish stale stored rules.
    var wpDeviceEditBaselines=[];
    function wpDeviceHasUnsavedSelections(){
      return wpDeviceEditBaselines.some(function(item){
        return item.control.value!==item.original;
      });
    }
    var deviceCards=E('div',{'class':'wp61-device-grid'},[]);
    var cardMeta=[];
    var pendingDeviceCount=E('span',{'class':'wp61-muted','role':'status','aria-live':'polite'},'');
    entries.forEach(function(d){
      var tr=deviceRow(d),cells=tr.children,ip=d[0];
      var name=wpDeviceDisplayName(d);
      var cfg=deviceRuleFor(ip).length>0;
      var route=(cells[1]&&cells[1].textContent)||'自动使用默认线路';
      var editBox=E('div',{'class':'wp61-device-edit'},[]);
      // Routine editing uses the single Save & Apply button below the device list.
      // Keep the select and its events, omit the legacy per-device save button.
      Array.prototype.slice.call(cells[2].childNodes).forEach(function(n){
        if (n.nodeType===1 && n.tagName==='BUTTON') return;
        editBox.appendChild(n);
      });
      Array.prototype.forEach.call(editBox.querySelectorAll('select'),function(control){
        wpDeviceEditBaselines.push({control:control,original:control.value,ip:ip,conflict:control.disabled});
      });
      var changeBadge=E('span',{'class':'wp61-status','style':'display:none;color:#a16207'},'未保存');
      var routeLabel=E('span',{'class':'wp61-route'},route);
      function wp124RouteClass(mode){ routeLabel.classList.remove('wp124-route-wan','wp124-route-wan1','wp124-route-balance','wp124-route-default'); routeLabel.classList.add(mode==='wan'?'wp124-route-wan':mode==='wan1'?'wp124-route-wan1':mode==='balance'||mode==='failover'?'wp124-route-balance':'wp124-route-default'); }
      wp124RouteClass(route || "default");
      var configuredBadge=E('span',{'class':'wp61-status '+(cfg?'is-configured':'')},cfg?'已单独设置':'默认上网');
      var card=E('details',{'class':'wp61-device-card'},[
        E('summary',{'class':'wp61-device-summary'},[
          E('span',{'class':'wp61-device-icon'},'▣'),
          E('span',{'class':'wp61-device-name'},[E('strong',{},name),E('small',{},ip)]),
          routeLabel,
          configuredBadge,
          changeBadge,
          E('span',{'class':'wp61-edit-hint','style':'font-size:12px;color:#4f63b7;white-space:nowrap'},'点击修改线路 ▾')
        ]),
        E('div',{'class':'wp61-device-inner'},[
          E('div',{'style':'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px'},[
            E('span',{'class':'wp61-muted'},'显示名称：'+name),
            E('button',{'type':'button','class':'btn cbi-button','click':function(ev){
              ev.preventDefault();ev.stopPropagation();
              var mac=(d[1]||'').toLowerCase();
              if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)){ui.addNotification(null,E('p',{},'当前设备没有有效 MAC 地址，暂时不能重命名。'),'warning');return;}
              var next=window.prompt('设备显示名称',name==='未命名设备'?'':name);
              if(next===null)return; next=next.trim();
              if(!next){ui.addNotification(null,E('p',{},'设备名称不能为空。'),'warning');return;}
              fs.exec('/usr/libexec/wanpilot',['device-name-set',mac,next]).then(function(r){
                if(!r||r.code!==0)throw new Error((r&&(r.stderr||r.stdout))||'保存失败');
                window.location.reload();
              }).catch(function(e){ui.addNotification(null,E('p',{},'重命名失败：'+e.message),'error');});
            }},'重命名')
          ]),
          E('div',{'class':'wp61-muted'},'选好线路后，点击页面下方的「保存并应用」。'),editBox
        ])
      ]);
      deviceCards.appendChild(card);
      cardMeta.push({element:card,search:(name+' '+ip).toLowerCase(),configured:cfg,changeBadge:changeBadge,routeLabel:routeLabel,configuredBadge:configuredBadge,ip:ip});
    });
    if(!entries.length)deviceCards.appendChild(E('p',{},'尚未发现设备'));
    var deviceCount=E('span',{'class':'wp61-muted'},'共 '+entries.length+' 台设备');
    function filterDeviceRows(){
      var q=(deviceSearch.value||'').toLowerCase().trim(),f=deviceFilter.value,n=0;
      var changedIps={};
      wpDeviceEditBaselines.forEach(function(entry){if(entry.control.value!==entry.original)changedIps[entry.ip]=true;});
      var pending=Object.keys(changedIps).length;
      pendingDeviceCount.textContent=pending?'待保存：'+pending+' 台设备':'所有设备设置已保存';
      cardMeta.forEach(function(item){
        var edited=!!changedIps[item.ip];
        var activeEdit=wpDeviceEditBaselines.find(function(entry){return entry.ip===item.ip;});
        if(activeEdit && edited) { item.routeLabel.textContent=outletLabel(activeEdit.control.value==='default'?'default':activeEdit.control.value).replace('需检查现有规则','自动使用默认线路'); item.routeLabel.classList.remove('wp124-route-wan','wp124-route-wan1','wp124-route-balance','wp124-route-default'); item.routeLabel.classList.add(activeEdit.control.value==='wan'?'wp124-route-wan':activeEdit.control.value==='wan1'?'wp124-route-wan1':activeEdit.control.value==='balance'||activeEdit.control.value==='failover'?'wp124-route-balance':'wp124-route-default'); }
        else if(activeEdit) { item.routeLabel.textContent=activeEdit.original==='default'?'自动使用默认线路':outletLabel(activeEdit.original); item.routeLabel.classList.remove('wp124-route-wan','wp124-route-wan1','wp124-route-balance','wp124-route-default'); item.routeLabel.classList.add(activeEdit.original==='wan'?'wp124-route-wan':activeEdit.original==='wan1'?'wp124-route-wan1':activeEdit.original==='balance'||activeEdit.original==='failover'?'wp124-route-balance':'wp124-route-default'); }
        item.changeBadge.style.display=edited?'':'none';
        var show=item.search.indexOf(q)>=0&&(f==='all'||(f==='configured'&&item.configured)||(f==='default'&&!item.configured)||(f==='edited'&&edited));
        item.element.style.display=show?'':'none';if(show)n++;
      });
      deviceCount.textContent='显示 '+n+' / '+entries.length+' 台设备';
    }
    deviceSearch.addEventListener('input',filterDeviceRows);
    deviceFilter.addEventListener('change',filterDeviceRows);
    wpDeviceEditBaselines.forEach(function(entry){entry.control.addEventListener('change',filterDeviceRows);});
    filterDeviceRows();
    var deviceInventory=E('div',{},[
      E('div',{'class':'wp61-device-tools'},[deviceSearch,deviceFilter,deviceCount,pendingDeviceCount]),
      deviceCards,
      E('details',{'class':'wp61-help'},[
        E('summary',{},'上网线路选项说明'),
        E('p',{},'默认上网：使用路由器现有规则；仅主线路／仅第二线路：指定设备连接策略；双线分担：新连接按权重分配；故障切换：优先主线，异常时尝试备用。')
      ])
    ]);
    var advancedWeights=E('details',{'style':'margin:10px 0 14px;border:1px solid #d7dce5;border-radius:10px;padding:12px'},[
      E('summary',{'style':'cursor:pointer;font-weight:600'},'高级选项：单独设置双线分担比例（仅影响选择此方式的设备）'),
      weightCard
    ]);
    var devicePanel=E('div',{'class':'cbi-section','style':'padding:12px 16px;border:1px solid #d7dce5;border-radius:12px;margin:10px 0'},[
      E('h3',{'style':'margin:2px 0 8px'},'设备与上网线路'),
      E('p',{'style':'font-size:13px;color:#64748b;margin:0 0 10px'},'选择设备的上网线路，然后在页面底部点击「保存并应用」。')
    ]);
    devicePanel.appendChild(deviceInventory);
    // Advanced per-device weights belong to advanced settings, not daily routing.
    // Keep the original DOM controls and listeners; only relocate the container.
    var diagnostics=E('div',{'class':'cbi-section'},[
      E('h3',{},'诊断信息'),
      E('p',{},'此处只读取规则命中与线路状态，不修改网络。')
    ]);
    // V4.4.1: overview is for link health and throughput only.
    // Move the existing read-only rule diagnostics without recreating handlers.
    diagnostics.appendChild(deviceRuntimeBox);
    // Overview has one source of truth: the live WAN monitor.
    // Move existing diagnostic controls and result area; preserve listeners.
    Array.prototype.slice.call(actions.children,-4).forEach(function(child){diagnostics.appendChild(child);});
    // V2.4: group global preview and application into the safety page.
    // The balance page keeps only the configured target slider and save result.
    var globalNodes=Array.prototype.slice.call(v17Card.children);
    var globalPreviewSection=E('div',{'class':'cbi-section'},[
      E('h3',{},'预览准备生效的线路比例'),
      E('p',{'style':'font-size:13px'},'预览及就绪检查不会更改当前网络。')
    ]);
    globalNodes.slice(6,12).forEach(function(el){globalPreviewSection.appendChild(el);});
    var globalApplySection=E('div',{'class':'cbi-section','style':'border:1px solid #cad3e0;border-radius:10px;padding:14px;margin:12px 0'},[]);
    globalNodes.slice(12,20).forEach(function(el){globalApplySection.appendChild(el);});
    var hitSection=E('div',{'class':'cbi-section'},[]);
    globalNodes.slice(20,24).forEach(function(el){hitSection.appendChild(el);});
    diagnostics.appendChild(hitSection);
    // V3.1: compact read-only release dashboard; never applies settings.
    var publishRaw=E('pre',{'id':'wp-v25-publish-summary','style':'white-space:pre-wrap;line-height:1.5;font-size:12px'},'尚未读取发布摘要');
    var currentValue=E('strong',{'id':'wp31-current','style':'font-size:23px'},'读取中…');
    var targetValue=E('strong',{'id':'wp31-target','style':'font-size:23px'},'读取中…');
    var barCurrent=E('div',{'id':'wp31-current-bar','style':'width:50%;height:100%;background:#667eea;transition:width .25s'});
    var barTarget=E('div',{'id':'wp31-target-bar','style':'width:50%;height:100%;background:#667eea;transition:width .25s'});
    function compactStat(label,value,bar){return E('div',{'style':'flex:1 1 260px;min-width:210px;background:#f8fafc;padding:15px;border-radius:10px;border:1px solid #e2e8f0'},[
      E('div',{'style':'font-size:13px;color:#64748b;margin-bottom:6px'},label),value,
      E('div',{'style':'height:8px;background:#d4dbe6;overflow:hidden;border-radius:8px;margin-top:12px'},bar)
    ]);}
    var configuredText=E('span',{'id':'wp31-rules'},'设备规则：读取中…');
    var releaseDiffState=E('div',{'id':'wp31-diff-state','style':'font-size:13px;color:#475569;margin:8px 0'},'正在加载策略差异…');
    var releaseChangeBadge=E('div',{'id':'wp47-change','style':'font-weight:600;font-size:14px;padding:9px 12px;background:#eff6ff;border-radius:7px;margin:10px 0'},'正在比较已保存设置与当前运行配置…');
    var nextAction=E('div',{'id':'wp50-next-action','role':'status','style':'border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:12px;margin:10px 0;font-size:14px'},'正在判断是否有需要应用的修改…');
    // V5.1: one clearly identified *navigation* action, never a network-changing shortcut.
    var v51Primary=E('button',{'type':'button','class':'btn cbi-button-action','disabled':true,
      'style':'min-width:180px',
      'click':function(ev){ev.preventDefault();protectedOperations.open=true;globalApplySection.scrollIntoView({behavior:'smooth',block:'center'});}},'读取设置中…');
    var v51State=E('div',{'role':'status','style':'font-weight:600;color:#334155'},'正在对比运行配置与已保存目标…');
    var v51Quick=E('div',{'style':'border:1px solid #cbd5e1;border-radius:10px;padding:16px;margin:8px 0;background:#fff'},[
      E('h3',{'style':'margin:0 0 8px'},'当前需要做什么？'),
      v51State,
      E('p',{'style':'margin:8px 0;color:#64748b;font-size:13px'},'流量比例与设备线路是两类独立设置。下面的按钮只定位到原有受保护操作区，不会自动修改网络。'),
      E('div',{'style':'display:flex;flex-wrap:wrap;gap:10px;align-items:center'},[
        v51Primary,
        E('button',{'type':'button','class':'btn cbi-button','click':function(ev){ev.preventDefault();protectedOperations.open=true;legacyPanel.open=true;legacyPanel.scrollIntoView({behavior:'smooth',block:'start'});}},'查看设备线路操作')
      ])
    ]);
    var publishSummary=E('div',{'class':'cbi-section','style':'border:1px solid #cbd5e1;border-radius:10px;padding:12px;margin:8px 0;background:#fff'},[
      E('div',{'style':'display:flex;flex-wrap:wrap;gap:12px'},[
        compactStat('当前运行 · WAN / WAN1',currentValue,barCurrent),
        compactStat('已保存目标 · WAN / WAN1',targetValue,barTarget)
      ]),
      E('details',{'style':'margin:10px 0;color:#475569;font-size:13px'},[E('summary',{},'设备规则与详细说明'),configuredText,releaseChangeBadge,nextAction,releaseDiffState]),
      E('div',{'style':'display:flex;gap:10px;align-items:center;flex-wrap:wrap'},[
        E('button',{'type':'button','class':'btn cbi-button','click':ui.createHandlerFn(this,function(){return refreshPublishSummary();})},'刷新配置对比（只读）'),
        E('details',{'style':'flex:1 1 100%;font-size:13px;margin-top:6px'},[
          E('summary',{'style':'cursor:pointer;color:#475569'},'查看原始发布摘要'),publishRaw
        ])
      ])
    ]);
    var publishSummaryRequestId=0;
    function refreshPublishSummary(){
      // A late response must not replace data from a newer refresh.
      var requestId=++publishSummaryRequestId;
      var output=viewNode('wp-v25-publish-summary');
      var info=viewNode('wp31-diff-state');
      if(output)output.textContent='正在读取配置及运行状态…';
      if(info)info.textContent='正在检查…';
      return fs.exec('/usr/libexec/wanpilot-v25-diff',[]).then(function(res){
        if(requestId!==publishSummaryRequestId || !root || !root.isConnected) return;
        var raw=(res.stdout||'')+(res.stderr?'\n'+res.stderr:'');
        if(output)output.textContent=(res.code===0?'':'检查未通过（退出码 '+res.code+'）\n')+raw;
        var live=raw.match(/当前\s*balanced\s*[:：]\s*([^\n]+)/i);
        var target=raw.match(/已保存目标\s*[:：]\s*WAN\s*(\d+)%\s*\/\s*WAN1\s*(\d+)%/i);
        var rules=raw.match(/设备规则\s*[:：]\s*([^\n]+)/);
        function setValue(prefix,a,b){
          var t=viewNode('wp31-'+prefix),bar=viewNode('wp31-'+prefix+'-bar');
          if(t)t.textContent=a+'% / '+b+'%';
          if(bar)bar.style.width=a+'%';
        }
        if(live){
          var one=live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
          var zero=live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
          if(one&&zero)setValue('current',Number(zero[1]),Number(one[1]));
          else {var cur=viewNode('wp31-current');if(cur)cur.textContent='请查看原始摘要';}
        }
        if(target)setValue('target',Number(target[1]),Number(target[2]));
        var change=viewNode('wp47-change');
        if(change){
          if(res.code!==0||!live||!target){change.textContent='无法确认普通设备的流量比例，暂勿应用；请查看详情';change.style.background='#fee2e2';}
          else {
            var z=live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i),o=live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
            if(!z||!o){change.textContent='无法读取当前运行比例，请查看详情';change.style.background='#fef3c7';}
            else if(Number(z[1])===Number(target[1])&&Number(o[1])===Number(target[2])){change.textContent='普通设备流量比例：当前运行与已保存目标一致。设备专属线路是否生效，请到「诊断信息」查看。';change.style.background='#dcfce7';}
            else {change.textContent='普通设备流量比例尚未按已保存目标运行；如需要变更，请先完成安全检查';change.style.background='#fef3c7';}
          }
        }
        // The guided shortcut is enabled only when the two valid ratios differ.
        var safeRatio=null, n0=null, n1=null;
        if(res.code===0 && live && target){
          n0=live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
          n1=live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
          if(n0&&n1 && +n0[1]+ +n1[1]===100 && +target[1]+ +target[2]===100)
            safeRatio=(+n0[1]===+target[1] && +n1[1]===+target[2]);
        }
        if(safeRatio===null){
          v51State.textContent='无法确认当前比例，请先查看安全检查和诊断信息。';
          v51Primary.disabled=true;
          v51Primary.textContent='数据不完整，暂不可操作';
        }else if(safeRatio){
          v51State.textContent='流量分担无需修改。设备专属线路可单独检查。';
          v51Primary.disabled=true;
          v51Primary.textContent='流量比例无需应用';
        }else{
          v51State.textContent='发现尚未应用的流量比例：WAN '+target[1]+'% / WAN1 '+target[2]+'%。';
          v51Primary.disabled=false;
          v51Primary.textContent='查看流量比例应用操作';
        }
        var recommendation=viewNode('wp50-next-action');
        if(recommendation){
          var w=live&&live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
          var w1=live&&live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
          if(res.code!==0||!w||!w1||!target){
            recommendation.textContent='当前无法确定设置是否一致，请先查看诊断结果；不要直接应用。';
            recommendation.style.background='#fef2f2';recommendation.style.borderColor='#fecaca';
          }else if(+w[1]===+target[1]&&+w1[1]===+target[2]){
            recommendation.textContent='流量分担：无需应用。当前比例与已保存目标一致。设备专属线路是单独的设置，请到「设备管理」检查；不要仅凭这里判断它已生效。';
            recommendation.style.background='#f0fdf4';recommendation.style.borderColor='#bbf7d0';
          }else{
            recommendation.textContent='流量分担：有待应用的修改（'+w[1]+'/'+w1[1]+' → '+target[1]+'/'+target[2]+'）。如确实希望改变当前网络，点击页面下方“保存并应用”即可。';
            recommendation.style.background='#fffbeb';recommendation.style.borderColor='#fde68a';
          }
        }
        if(rules){var rc=viewNode('wp31-rules');if(rc)rc.textContent='设备规则：'+rules[1];}
        if(info)info.textContent=res.code===0?'此处比较的是普通设备的流量分担比例；不能据此判断设备专属线路已生效。应用前仍需执行安全检查。':'发布摘要异常，请展开原始结果排查；暂勿应用策略。';
      }).catch(function(err){if(requestId!==publishSummaryRequestId || !root || !root.isConnected)return;if(output)output.textContent=String(err);if(info)info.textContent='发布摘要读取失败，暂勿应用策略。';v51State.textContent='读取失败，请先检查诊断信息。';v51Primary.disabled=true;v51Primary.textContent='暂不可操作';});
    }
    actions.insertBefore(publishSummary,actions.firstChild);
    // V2.6: separate read-only integrity check; never auto-applies changes.
    var auditStatus=E('div',{'id':'wp47-audit-status','style':'background:#f1f5f9;border-radius:7px;padding:10px 12px;margin:8px 0;font-weight:600'},'尚未检查。应用前请点击下方安全检查按钮。');
    var auditCard=E('div',{'class':'cbi-section','style':'border:1px solid #cbd5e1;border-radius:10px;padding:16px;margin:12px 0'},[
      E('h3',{},'安全检查（不会更改网络）'),
      E('p',{'style':'font-size:13px;color:#64748b'},'检查当前配置是否适合安全发布，不会更改网络。'),
      auditStatus,
      E('pre',{'id':'wp-v26-audit-result','style':'white-space:pre-wrap;line-height:1.7'},'尚未检查'),
      E('button',{'type':'button','class':'btn cbi-button','click':ui.createHandlerFn(this,function(){
        var out=viewNode('wp-v26-audit-result');
        if(out)out.textContent='正在核验…';var st=viewNode('wp47-audit-status');if(st){st.textContent='正在检查…';st.style.background='#f1f5f9';}
        var auditGeneration=guideGeneration;var auditEligible=!guideCheck.disabled&&guideScope.value==='global';guidePublish.disabled=true;guideAudit.textContent='正在执行安全检查，请等待完成…';
        return fs.exec('/usr/libexec/wanpilot-v26-audit',[]).then(function(r){
          if(out)out.textContent=(r.code===0?'':'安全检查未通过（退出码 '+r.code+'）\n')+(r.stdout||'')+(r.stderr||'');
          var ok=r.code===0&&/READY FOR PREVIEW/.test(r.stdout||'');
          var st=viewNode('wp47-audit-status');if(st){st.textContent=ok?'检查通过：当前状态允许继续准备预览；实际应用仍需执行原有就绪检查。':'检查未通过或结果不完整：请展开详情，暂勿应用';st.style.background=ok?'#dcfce7':'#fee2e2';}
          if(auditGeneration===guideGeneration){guidePublish.disabled=!(ok&&auditEligible);showRelevantWizardSteps(guideScope.value,auditEligible,ok&&auditEligible);guideAudit.textContent=ok&&auditEligible?'检查通过，可使用页面下方“保存并应用”。':ok?'检查通过，但没有确认的待应用比例，不开放快捷发布。':'检查未通过，暂时不能继续。';}
        }).catch(function(e){if(out)out.textContent='无法完成检查：'+String(e);var st=viewNode('wp47-audit-status');if(st){st.textContent='检查失败，暂勿应用';st.style.background='#fee2e2';}if(auditGeneration===guideGeneration){guidePublish.disabled=true;showRelevantWizardSteps(guideScope.value,false,false);guideAudit.textContent='检查失败，暂时不能继续。';}});
      })},'检查是否可以安全应用')
    ]);
    // Keep raw safety audit visible on demand, while retaining its original handler.
    var auditResult=viewNode('wp-v26-audit-result');
    // The element is created but not mounted yet: move it by reference, not by querying document.
    var auditPre=Array.prototype.slice.call(auditCard.querySelectorAll('pre'))[0];
    if(auditPre){var auditDetails=E('details',{'style':'margin-top:10px'},[E('summary',{'style':'cursor:pointer'},'查看完整安全检查输出'),auditPre]);auditCard.appendChild(auditDetails);}
    actions.insertBefore(auditCard,actions.firstChild);

    // V3.0: guided publication layout. Keep tested buttons and their event handlers unchanged.
    var releaseHero=E('div',{'class':'cbi-section','style':'border:1px solid #cbd5e1;border-radius:12px;padding:10px;margin:6px 0;background:#f8fafc'},[
      E('h2',{'style':'margin:0 0 6px 0'},'应用更改'),
      E('p',{'style':'font-size:13px;margin:4px 0'},'先看是否有修改，再做安全检查；设备线路和流量分担需要分别应用。'),
      E('div',{'id':'wp-v30-release-state','style':'font-weight:600;border-left:4px solid #64748b;padding:10px 12px;background:#fff;margin:12px 0'},'正在读取保护状态…'),
      E('p',{'style':'color:#64748b;margin:6px 0 0;font-size:12px'},'变更运行网络后，请在 120 秒内确认；否则系统尝试自动恢复。')
    ]);
    var step1=E('div',{'class':'cbi-section','style':'margin:8px 0'},[
      E('h3',{},'① 看看将改变什么'),publishSummary
    ]);
    var step2=E('div',{'class':'cbi-section','style':'margin:8px 0'},[
      E('h3',{},'② 检查能否安全更改'),auditCard,E('details',{'style':'margin:10px 0;border:1px solid #e2e8f0;border-radius:8px;padding:10px'},[E('summary',{'style':'cursor:pointer;font-weight:600'},'高级选项：预览准备写入的配置（只读）'),globalPreviewSection])
    ]);
    var step3=E('div',{'class':'cbi-section','style':'margin:8px 0'},[
      E('h3',{},'③ 按需应用、确认或恢复'),
      E('p',{'style':'font-size:13px;color:#64748b'},'以下保留原有的应用、确认和恢复按钮；应用后必须在约 120 秒内确认。'),
      globalApplySection,
      E('div',{'style':'margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc'},[
        E('strong',{},'修改某台设备的上网线路？'),
        E('p',{'style':'font-size:13px;margin:8px 0'},'请先到“设备管理”保存目标线路，再展开“高级操作”中的设备线路安全应用。应用后需在 120 秒内确认，否则系统尝试自动恢复。'),
        E('button',{'type':'button','class':'btn cbi-button','click':function(){protectedOperations.open=true;legacyPanel.open=true;legacyPanel.scrollIntoView({behavior:'smooth',block:'start'});}},'展开设备线路应用操作')
      ])
    ]);
    // V4.4: make the historic diagnostic controls optional without changing their handlers.
    // Exclude the five guided sections and any status elements they contain.
    var legacyNodes=Array.prototype.slice.call(actions.childNodes);
    var legacyPanel=E('details',{'style':'margin:14px 0;padding:12px;border:1px solid #d7dce5;border-radius:9px'},[
      E('summary',{'style':'cursor:pointer;font-weight:600'},'高级操作（故障排查与旧版工具）'),
      E('p',{'style':'color:#64748b;font-size:13px'},'日常设置一般不需要使用这里的按钮；进行真实设备策略应用时，请按此处的安全操作说明，且保留自动恢复保护。')
    ]);
    legacyNodes.forEach(function(el){legacyPanel.appendChild(el);});
    actions.appendChild(legacyPanel);
    // The original device controls remain inside actions, after the guided global section.
    actions.insertBefore(step3,actions.firstChild);
    actions.insertBefore(step2,actions.firstChild);
    actions.insertBefore(step1,actions.firstChild);
    // V5.2: staged, non-network-changing guidance. Original protected controls are preserved.
    var guidePhase=E('div',{'id':'wp52-phase','role':'status','style':'padding:10px 12px;background:#f1f5f9;border-radius:8px;font-weight:600'},'正在读取当前设置…');
    var guideAudit=E('div',{'id':'wp52-audit','role':'status','style':'color:#64748b;font-size:13px'},'尚未执行本次安全检查。');
    var guidePublish=E('button',{'type':'button','class':'btn cbi-button-action','disabled':true,'click':function(ev){
      ev.preventDefault();revealGuideStep(step3);step3.scrollIntoView({behavior:'smooth',block:'start'});
    }},'请先检查是否有待应用修改');
    var guideCheck=E('button',{'type':'button','class':'btn cbi-button','disabled':true,'click':function(ev){
      ev.preventDefault();revealGuideStep(step2);step2.scrollIntoView({behavior:'smooth',block:'start'});
    }},'开始安全检查');
    var guideChange=E('button',{'type':'button','class':'btn cbi-button','click':function(ev){
      ev.preventDefault();var wanted=viewNode('wp52-scope').value;
      ++guideGeneration;guidePublish.disabled=true;guideCheck.disabled=true;guideAudit.textContent='设置页面可能发生修改。返回后重新读取并检查。';switchTab('devices');
    }},'去修改设置');
    var guideScope=E('select',{'id':'wp52-scope','class':'cbi-input-select','style':'max-width:290px'},[
      E('option',{'value':'global'},'普通设备：调整两条线路分担比例'),
      E('option',{'value':'device'},'某台设备：选择专用线路')
    ]);
    var nextHint=E('div',{'class':'wp64-next','role':'status','style':'padding:16px 18px;border-radius:13px;border:1px solid #dce5f1;background:#f6f9ff;font-weight:650;font-size:16px'},'正在确认当前设置…');
    var wizard=E('div',{'class':'wp62-wizard','style':'border:1px solid #cbd5e1;background:#fff;border-radius:12px;padding:18px;margin:10px 0;display:grid;gap:14px'},[
      E('h2',{'style':'margin:0'},'现在需要做什么？'),nextHint,
      E('p',{'style':'margin:0;color:#64748b'},'只处理已保存且确实需要应用的修改；状态不明确时停止操作。'),
      E('div',{'style':'display:grid;gap:8px;padding:12px;border:1px solid #e2e8f0;border-radius:9px'},[
        E('strong',{},'① 查看哪类设置需要处理'),guideScope,guidePhase,E('div',{'class':'wp62-wizard-tools'},[guideChange,E('button',{'type':'button','class':'btn cbi-button','click':function(ev){ev.preventDefault();refreshWizard();refreshReleaseBanner();}},'重新读取状态（只读）')])
      ]),
      E('div',{'style':'display:grid;gap:8px;padding:12px;border:1px solid #e2e8f0;border-radius:9px'},[
        E('strong',{},'② 确认有修改后，检查网络安全'),guideCheck,guideAudit
      ]),
      E('div',{'style':'display:grid;gap:8px;padding:12px;border:1px solid #e2e8f0;border-radius:9px'},[
        E('strong',{},'③ 检查通过后，应用并确认'),guidePublish,
        E('span',{'style':'font-size:12px;color:#64748b'},'此按钮只展开安全操作，不会直接更改网络。应用后需要在 120 秒内确认。')
      ])
    ]);
    // V6.2: the everyday wizard only displays actionable steps. This changes
    // presentation only; no backend operation is invoked by these conditions.
    // Refer to the actual step elements; layout changes must not alter targeting.
    var wizardStepCheck=guideCheck.parentNode;
    var wizardStepApply=guidePublish.parentNode;
    function showRelevantWizardSteps(scope,canCheck,canApply){
      wizardStepCheck.style.display=scope==='global'&&canCheck?'grid':'none';
      wizardStepApply.style.display=scope==='global'&&canApply?'grid':'none';
    }
    showRelevantWizardSteps('global',false,false);
    // Hide detailed legacy step panels until user intentionally enters the phase.
    var guidedDetails=E('details',{'style':'margin:8px 0;padding:12px;border:1px solid #e2e8f0;border-radius:9px'},[
      E('summary',{'style':'cursor:pointer;font-weight:600'},'查看安全应用与详细工具'),step1,step2,step3
    ]);
    [step1,step2,step3].forEach(function(el){el.style.display='none';});
    function revealGuideStep(el){guidedDetails.open=true;[step1,step2,step3].forEach(function(x){x.style.display='none';});el.style.display='block';}
    guideCheck.addEventListener('click',function(){revealGuideStep(step2);});
    guidePublish.addEventListener('click',function(){revealGuideStep(step3);});
    // Safety-check result is delivered by the actual audit Promise, never by a fixed timer.
    var guideGeneration=0;
    function refreshWizard(){
      ++guideGeneration;
      guideCheck.disabled=true;
      guidePublish.disabled=true;
      guideAudit.textContent='配置已重新读取，需重新执行安全检查。';
      showRelevantWizardSteps(guideScope.value,false,false);
      var thisGeneration=guideGeneration;
      return fs.exec('/usr/libexec/wanpilot-v25-diff',[]).then(function(r){
        if(thisGeneration!==guideGeneration)return;
        var raw=r.stdout||'';var l=raw.match(/当前\s*balanced\s*[:：]\s*([^\n]+)/i);
        var t=raw.match(/已保存目标\s*[:：]\s*WAN\s*(\d+)%\s*\/\s*WAN1\s*(\d+)%/i);
        var a=l&&l[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
        var b=l&&l[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
        var pending=/待确认:\s*yes/i.test(raw);
        guidePublish.disabled=true;guideAudit.textContent='尚未执行本次安全检查。';
        if(r.code!==0||!a||!b||!t||+a[1]+ +b[1]!==100||+t[1]+ +t[2]!==100){
          nextHint.textContent='无法确认当前设置，请查看「诊断信息」，不要应用网络。';nextHint.style.background='#fef2f2';guidePhase.textContent='状态读取不完整：停止操作，请到诊断信息查看。';guideCheck.disabled=true;return;
        }
        if(pending){nextHint.textContent='有正在等待确认的网络更改，请优先确认保留或恢复原设置。';nextHint.style.background='#fff7ed';guidePhase.textContent='存在待确认操作：请先完成确认或恢复，不能继续发布。';guideCheck.disabled=true;return;}
        var different=(+a[1]!==+t[1]||+b[1]!==+t[2]);
        nextHint.textContent=guideScope.value==='device'?'设备线路：先核对设备配置，确认是否有变化。':different?'流量分担有待应用修改：先进行安全检查，再决定是否应用。':'流量分担已与目标一致，不需要操作。';nextHint.style.background=different?'#fff7ed':'#f0fdf4';
        guidePhase.textContent=guideScope.value==='device'?'设备线路：请先在「设备管理」保存修改。目前无法自动判断设备规则是否需要发布，因此不会开放快捷发布入口。':(different?'流量分担待应用：当前 '+a[1]+'/'+b[1]+'，已保存 '+t[1]+'/'+t[2]+'。':'流量分担已一致（'+a[1]+'/'+b[1]+'），无需重复应用。');
        guideCheck.disabled=guideScope.value!=='global'||!different;
        showRelevantWizardSteps(guideScope.value,!guideCheck.disabled,false);
        if(guideScope.value==='device'){guideCheck.disabled=true;guidePublish.disabled=true;guideAudit.textContent=deviceCheckDetail.textContent;guidePhase.textContent=deviceCheckState.textContent;}
        else if(guideCheck.disabled)guideAudit.textContent='当前比例一致，无需重复发布。';
      }).catch(function(){if(thisGeneration!==guideGeneration)return;nextHint.textContent='设置读取失败，暂勿操作。';nextHint.style.background='#fef2f2';guidePhase.textContent='状态读取失败，暂停操作。';guideCheck.disabled=true;guidePublish.disabled=true;});
    }
    // V5.6: read-only comparison of saved device rules against UCI mwan3 rules.
    // This is NOT a kernel/runtime verification, and never unlocks a device apply shortcut.
    var deviceCheckGeneration=0;
    // V5.8: one device-comparison state drives both the device pane and guide step 3.
    // This is deliberately informational; it never grants publishing permission.
    var deviceCheckState=E('div',{'id':'wp58-device-state','role':'status','style':'padding:10px 12px;border-radius:8px;background:#f1f5f9;font-weight:600'},'设备线路：尚未检查。');
    var deviceCheckDetail=E('div',{'id':'wp58-device-next','style':'color:#64748b;font-size:13px'},'先检查已保存的设备线路是否与路由器配置对应。');
    function setDeviceGuideState(kind, message, next){
      var colors={idle:'#f1f5f9',busy:'#f1f5f9',matched:'#dcfce7',changed:'#fef3c7',unknown:'#fee2e2'};
      deviceCheckState.style.background=colors[kind]||colors.unknown;
      deviceCheckState.textContent=message;
      if(guideScope.value==='device'){nextHint.textContent=kind==='matched'?'设备设置与配置文件对应；未验证公网出口。':kind==='changed'?'发现设备配置差异，请核对设备管理设置；不要直接发布。':kind==='unknown'?'设备状态无法确定，请查看诊断信息。':kind==='busy'?'正在核对设备线路…':'先检查设备线路是否与已保存设置对应。';nextHint.style.background=kind==='matched'?'#f0fdf4':kind==='changed'?'#fff7ed':kind==='unknown'?'#fef2f2':'#f6f9ff';}
      deviceCheckDetail.textContent=next;
      deviceCompareButton.textContent=kind==='matched'?'重新检查':kind==='busy'?'检查中…':'检查设备线路（只读）';
      deviceCompareButton.style.width=kind==='matched'?'auto':'auto';
      // Old guide's third-stage button cannot be reused to approve device publishing.
      guidePublish.disabled=true;
      showRelevantWizardSteps(guideScope.value,false,false);
      if(guideScope.value==='device'){
        guidePhase.textContent=message;
        guideAudit.textContent=next;
        guidePublish.textContent=kind==='matched'?'设备配置一致，无需再次应用':kind==='busy'?'正在检查设备配置…':kind==='changed'?'有配置差异，暂不开放应用':kind==='unknown'?'状态不明确，请核验':'请先检查设备配置';
      }
    }
    // V5.9 concise per-device results sourced from the same read-only comparison.
    var deviceSummary=E('div',{'id':'wp59-device-summary','style':'display:grid;gap:7px;margin:8px 0'},[]);
    function renderDeviceSummary(items){
      while(deviceSummary.firstChild)deviceSummary.removeChild(deviceSummary.firstChild);
      items.forEach(function(item){
        var lease=leaseRows.filter(function(d){return d[0]===item.ip;})[0];
        var matching=uci.sections('wanpilot','rule').filter(function(r){return (r.src_ip||r.device_ip||'').replace(/\/32$/,'')===item.ip;})[0];
        var profile=matching?uci.sections('wanpilot','profile').filter(function(p){return p.name===matching.profile;})[0]:null;
        var route=profile&&profile.mode==='single'?(profile.primary==='wan1'?'仅 WAN1 · 第二线路':profile.primary==='wan'?'仅 WAN · 主线路':'指定线路'):
          profile&&profile.mode==='balance'?'两条线路分担':profile&&profile.mode==='failover'?(profile.primary==='wan1'?'WAN1 优先 / WAN 备用':'WAN 优先 / WAN1 备用'):'自定义线路设置';
        var name=lease&&lease[2]&&lease[2]!=='*'?lease[2]:(matching&&matching.name&&matching.name!=='*'?matching.name:'未命名设备');
        var status=item.state==='matched'?'配置对应':item.state==='changed'?'需要检查':'暂无法判断';
        var bg=item.state==='matched'?'#dcfce7':item.state==='changed'?'#fef3c7':'#fee2e2';
        deviceSummary.appendChild(E('div',{'style':'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px'},[
          E('div',{},[E('strong',{},name),E('div',{'style':'font-size:12px;color:#64748b'},item.ip)]),
          E('div',{'style':'font-size:13px'},route),
          E('span',{'style':'font-size:12px;font-weight:600;background:'+bg+';padding:5px 9px;border-radius:16px'},status)
        ]));
      });
    }
    var deviceComparison=E('div',{'id':'wp56-device-comparison','style':'font-size:13px;line-height:1.6;white-space:pre-wrap'},'选择设备线路后，可检查已保存规则与当前 mwan3 配置是否对应。');
    var deviceCompareButton=E('button',{'type':'button','class':'btn cbi-button','click':function(ev){
      ev.preventDefault();
      var checkId=++deviceCheckGeneration;
      ++deviceSafetyGeneration;deviceHasVerifiedDifference=false;deviceSafetyButton.disabled=true;deviceSafetyMessage.textContent='设备规则正在重新检查；之前的预检不再有效。';
      deviceCompareButton.disabled=true;
      deviceComparison.textContent='正在读取设备与网络规则（只读）…';
      renderDeviceSummary([]);
      setDeviceGuideState('busy','正在检查设备线路…','检查完成后再决定是否需要操作。');
      guideAudit.textContent='正在检查设备配置。检查结束前请勿发布。';
      return Promise.all([uci.load('wanpilot'),uci.load('mwan3')]).then(function(){
        if(checkId!==deviceCheckGeneration)return;
      var rules=uci.sections('wanpilot','rule').filter(function(x){return x.enabled!=='0' && (x.src_ip||x.device_ip);});
        var runtimeRules=uci.sections('mwan3','rule');
        if(!rules.length){deviceComparison.textContent='当前没有已启用的设备专用规则。';setDeviceGuideState('matched','暂无设备专用规则，无需应用','如果要给设备指定线路，请先进入「设备管理」保存设置。');return;}
        var lines=[],same=0,changed=0,unknown=0,displayItems=[];
        rules.forEach(function(rule){
          var source=rule.src_ip||rule.device_ip;
          var policy='wpx_p_'+(rule.profile||'');
          if(!/^\d{1,3}(?:\.\d{1,3}){3}(?:\/32)?$/.test(source)||!rule.profile){
            lines.push(source+'：无法确定（复杂规则请在诊断信息核验）');displayItems.push({ip:source.replace(/\/32$/,''),state:'unknown'});unknown++;return;
          }
          var normalized=source.replace(/\/32$/,'');
          var candidates=runtimeRules.filter(function(x){return x.enabled!=='0' && (x.src_ip||'').replace(/\/32$/,'')===normalized;});
          var matches=candidates.filter(function(x){return x.use_policy===policy;});
          if(matches.length===1 && candidates.length===1){same++;displayItems.push({ip:normalized,state:'matched'});lines.push(normalized+'：配置对应；尚未验证实际出口');}
          else if(candidates.length===0){changed++;displayItems.push({ip:normalized,state:'changed'});lines.push(normalized+'：当前 mwan3 配置中未找到该设备的对应规则');}
          else if(candidates.length===1 && matches.length===0){changed++;displayItems.push({ip:normalized,state:'changed'});lines.push(normalized+'：目标线路配置与已保存规则不一致');}
          else{unknown++;displayItems.push({ip:normalized,state:'unknown'});lines.push(normalized+'：存在多条匹配规则，无法安全判断');}
        });
        renderDeviceSummary(displayItems);
        var next=unknown?'下一步：存在无法判断的规则，请到「诊断信息」核对；不要使用快捷发布。':changed?'下一步：发现设备配置差异，请在「设备管理」核对已保存线路，再通过现有受保护流程操作。':'下一步：已保存设备配置与 mwan3 配置对应，无需重复发布；如需验证实际出口，请使用独立出口检测。';
        deviceComparison.textContent='配置对照：对应 '+same+' 条；差异 '+changed+' 条；待核验 '+unknown+' 条。\n'+lines.join('\n')+'\n注意：只对照配置，不证明规则实际加载、匹配优先级或真实公网出口。';
        deviceHasVerifiedDifference=changed>0 && unknown===0;
        deviceSafetyButton.disabled=!deviceHasVerifiedDifference;
        deviceSafetyMessage.textContent=deviceHasVerifiedDifference?'发现明确设备配置差异：可以运行只读后端预检。':(unknown?'存在无法判断的设备规则，禁止快捷预检。':'设备配置已对应，无需应用。');
        if(unknown)setDeviceGuideState('unknown','设备配置存在无法判断的情况','请在「诊断信息」核对规则，不要直接应用。');
        else if(changed)setDeviceGuideState('changed','发现 '+changed+' 条设备配置差异','请先在「设备管理」核对已保存线路，再使用原有受保护流程；本页不自动发布。');
        else setDeviceGuideState('matched','设备配置一致，无需再次应用','已对照 '+same+' 条设备规则。仅确认配置对应，未验证实际公网出口。');
      }).catch(function(e){if(checkId!==deviceCheckGeneration)return;deviceHasVerifiedDifference=false;deviceSafetyButton.disabled=true;deviceComparison.textContent='设备配置对照失败：'+String(e)+'。请到「诊断信息」检查；暂停发布。';setDeviceGuideState('unknown','设备线路状态无法确认','请到「诊断信息」核验，暂勿发布。');}).finally(function(){if(checkId===deviceCheckGeneration)deviceCompareButton.disabled=false;});
    }},'检查设备规则是否对应（只读）');
    // Device publishing assist: preflight only; the proven legacy safe controls own all writes.
    // Always repeat backend validation at apply time; a UI READY result is not authorization.
    var deviceSafetyMessage=E('div',{'role':'status','style':'font-size:13px;line-height:1.6'},'先对照设备配置，再执行后端安全预检。');
    var deviceSafetyButton=E('button',{'type':'button','class':'btn cbi-button','disabled':true,'click':function(ev){
      ev.preventDefault();
      var run=++deviceSafetyGeneration;
      deviceSafetyButton.disabled=true;
      deviceSafetyMessage.textContent='正在运行设备安全预检（不会应用网络配置）…';
      return Promise.all([
        fs.exec('/usr/libexec/wanpilot-safe',['status']),
        fs.exec('/usr/libexec/wanpilot-global-safe',['status'])
      ]).then(function(st){
        if(st.some(function(x){return x.code!==0 || !/(?:^|\n)pending=no(?:\n|$)/.test(x.stdout||'');})) throw Error('当前存在待确认任务或保护状态不明确');
        return fs.exec('/usr/libexec/wanpilot-safe',['check']);
      }).then(function(res){
        if(run!==deviceSafetyGeneration)return;
        var msg=(res.stdout||'')+'\n'+(res.stderr||'');
        if(res.code!==0 || !/READY PASS:/.test(msg) || !/STAGE PASS:/.test(msg)) throw Error('后端预检未通过：'+msg.slice(0,1000));
        var origin=msg.match(/Original SHA256:\s*([0-9a-f]{64})/i);
        var candidate=msg.match(/Candidate SHA256:\s*([0-9a-f]{64})/i);
        if(!origin||!candidate) throw Error('预检缺少配置指纹，拒绝继续');
        if(origin[1]===candidate[1]) {deviceSafetyMessage.textContent='预检通过，但设备运行配置已与保存设置一致，无需重复应用。';return;}
        deviceSafetyMessage.textContent='预检通过，确认存在待应用配置差异。请在下方「安全应用与详细工具」中手动应用，并在 120 秒内确认。';
        revealGuideStep(step3);
        step3.scrollIntoView({behavior:'smooth',block:'start'});
      }).catch(function(err){
        if(run!==deviceSafetyGeneration)return;
        deviceSafetyMessage.textContent='无法安全发布：'+String(err)+'。请保留现有配置并检查诊断信息。';
      }).finally(function(){if(run===deviceSafetyGeneration)deviceSafetyButton.disabled=!deviceHasVerifiedDifference;});
    }},'运行设备安全预检（只读）');
    var deviceSafetyGeneration=0;
    var deviceHasVerifiedDifference=false;
    var deviceCompareArea=E('div',{'id':'wp56-device-compare-area','style':'display:none;border:1px solid #e2e8f0;border-radius:8px;padding:12px'},[
      E('strong',{},'设备线路设置'),deviceCheckState,deviceCheckDetail,deviceSummary,deviceCompareButton,deviceSafetyButton,deviceSafetyMessage,E('details',{},[E('summary',{},'查看设备规则对照详情'),deviceComparison])
    ]);
    wizard.appendChild(deviceCompareArea);
    function updateDeviceComparisonVisibility(){nextHint.style.display=guideScope.value==='device'?'none':'';guidePhase.style.display=guideScope.value==='device'?'none':'';++deviceSafetyGeneration;deviceHasVerifiedDifference=false;deviceSafetyButton.disabled=true;deviceSafetyMessage.textContent='先对照设备配置，再运行安全预检。';++deviceCheckGeneration;deviceCompareButton.disabled=false;renderDeviceSummary([]);deviceCompareArea.style.display=guideScope.value==='device'?'grid':'none';deviceComparison.textContent='尚未检查。';if(guideScope.value==='device')setDeviceGuideState('idle','设备线路：尚未检查','点击下方按钮检查是否已对应。');else guidePublish.textContent='请先检查是否有待应用修改';}
    guideScope.addEventListener('change',function(){showRelevantWizardSteps(guideScope.value,false,false);updateDeviceComparisonVisibility();});
    updateDeviceComparisonVisibility();
    guideScope.addEventListener('change',function(){refreshWizard();guidedDetails.open=false;[step1,step2,step3].forEach(function(x){x.style.display='none';});});
    actions.insertBefore(guidedDetails,actions.firstChild);
    actions.insertBefore(wizard,actions.firstChild);
    // V6: keep status nodes mounted but avoid displaying redundant introductory panels.
    // Real apply / confirm / rollback elements remain accessible in advanced operations.
    releaseHero.style.display='none';
    window.setTimeout(refreshWizard,650);
    var releaseStateNode=releaseHero.querySelector('#wp-v30-release-state');
    if(releaseStateNode)wizard.insertBefore(releaseStateNode,wizard.children[1] || null);
    releaseHero.style.display='none';
    function refreshReleaseBanner(){
      var el=viewNode('wp-v30-release-state');if(!el)return;
      return Promise.all([
        fs.exec('/usr/libexec/wanpilot-safe',['status']),
        fs.exec('/usr/libexec/wanpilot-global-safe',['status'])
      ]).then(function(results){
        if(results.some(function(r){return r.code!==0;}))throw new Error('安全应用器返回异常');
        function prop(output,key){var m=(output||'').match(new RegExp('(?:^|\\n)'+key+'=([^\\n]*)'));return m?m[1]:null;}
        var d=prop(results[0].stdout,'pending'),g=prop(results[1].stdout,'pending');
        if(d===null||g===null)throw new Error('无法判定待确认状态');
        if(d!=='no'||g!=='no'){
          el.style.borderLeftColor='#b45309';
          el.style.background='#fff7ed';
          el.textContent='正在等待确认：请立即选择「确认保留」或「恢复原设置」。超过约 120 秒未确认，后台会尝试自动恢复。';
          // Do not hide real confirm/rollback controls behind an optional details toggle.
          // Only open UI panels; never submit or confirm a network change automatically.
          guidedDetails.open=true;
          revealGuideStep(step3);
          if(d!=='no'){protectedOperations.open=true;legacyPanel.open=true;}
          if(g!=='no'){protectedOperations.open=true;globalApplySection.style.display='block';}
          nextHint.textContent='有网络修改正在等待确认，请优先完成确认或恢复。';
          nextHint.style.background='#fff7ed';
          guideCheck.disabled=true;
          guidePublish.disabled=true;
          showRelevantWizardSteps(guideScope.value,false,false);
        }else{
          el.style.borderLeftColor='#15803d';
          el.style.background='#f0fdf4';
          el.textContent='当前没有等待确认的网络操作。';
        }
      }).catch(function(e){el.style.borderLeftColor='#b91c1c';el.style.background='#fef2f2';el.textContent='无法读取安全状态，请暂停网络更改并进入诊断信息。';nextHint.textContent='安全状态未知，不能继续应用。';nextHint.style.background='#fef2f2';guideCheck.disabled=true;guidePublish.disabled=true;showRelevantWizardSteps(guideScope.value,false,false);});
    }
    // Banner is informational only: the existing backend checks remain authoritative.
    actions.addEventListener('click',function(){window.setTimeout(refreshReleaseBanner,1000);});
    window.setTimeout(refreshReleaseBanner,450);

    // Four-screen presentation layer. All original handlers and safe backends remain unchanged.
    // The protected apply controls are kept mounted, but folded away from daily work.
    var recoveryShortcut=E('p',{'style':'margin:12px 0'},E('a',{'href':L.url('admin/network/wanpilot-recovery'),'class':'btn cbi-button'},'打开独立应急恢复页面'));
    // The actions element is not mounted yet here; do not access actions.parentNode.
    var protectedOperations=E('details',{'class':'wp7-protected','style':'margin:16px 0;border:1px solid #e2e8f0;border-radius:12px;padding:12px'},[
      E('summary',{'style':'font-weight:650;cursor:pointer'},'安全应用与恢复 · 120 秒保护'),
      E('p',{'style':'font-size:13px;color:#64748b'},'仅在保存目标设置后展开。设备与全局比例使用各自已经安装的受保护流程；任何待确认操作须先完成或回滚。'),
      actions
    ]);
    // V7.1: read-only transaction gate; independent of the apply controls.
    // Both engines must report an idle state before any new operation is offered.
    var wp71Notice=E('div',{'role':'status','style':'padding:13px 16px;border:1px solid #dae3ef;border-radius:12px;background:#f8fafc;margin:10px 0;color:#334155'},'应用状态：正在检查…');
    var wp71Busy=false;
    function wp71StatusValue(body,key){
      var match=String(body||'').match(new RegExp('(?:^|\\n)'+key+'=([^\\n]*)'));
      return match?match[1].trim():null;
    }
    function wp71Refresh(){
      if(wp71Busy)return Promise.resolve();
      wp71Busy=true;
      return Promise.all([
        fs.exec('/usr/libexec/wanpilot-safe',['status']),
        fs.exec('/usr/libexec/wanpilot-global-safe',['status'])
      ]).then(function(rs){
        if(rs.some(function(r){return r.code!==0;}))throw Error('状态接口返回失败');
        var d=wp71StatusValue(rs[0].stdout,'pending');
        var g=wp71StatusValue(rs[1].stdout,'pending');
        if(d==='yes'||g==='yes'){
          wp71Notice.textContent='安全应用正在等待确认：请完成原有人工确认或等待自动回滚。此时禁止发起其它变更。';
          wp71Notice.style.borderColor='#f59e0b';
        }else if(d==='no'&&g==='no'){
          wp71Notice.textContent='安全事务空闲。需要调整线路时，请到「设备分流」操作。';
          wp71Notice.style.borderColor='#dae3ef';
        }else{
          wp71Notice.textContent='事务状态不能确认，请到「诊断日志」检查；不要启动应用。';
          wp71Notice.style.borderColor='#ef4444';
        }
      }).catch(function(){
        wp71Notice.textContent='无法验证安全事务状态：暂停新的应用，请到「诊断日志」检查。';
        wp71Notice.style.borderColor='#ef4444';
      }).finally(function(){wp71Busy=false;});
    }
    // V7.2: read-only eligibility classifier. This NEVER grants apply permission.
    var wp72Gate=E('div',{'role':'status','style':'padding:12px 14px;margin:8px 0;border-radius:10px;border:1px solid #dce4ed'},'正在读取后台协调状态…');
    function wp72UpdateGate(){
      return fs.exec('/usr/libexec/wanpilot-coordinator',['inspect']).then(function(r){
        if(r.code!==0)throw Error('协调状态检测失败');
        var verdict=wp71StatusValue(r.stdout,'verdict');
        var reason=wp71StatusValue(r.stdout,'reason');
        var dict={idle:'安全事务空闲；需要应用时继续使用现有受保护操作流程。',blocked_pending:'存在未完成的安全事务；禁止新应用。',blocked_uci:'检测到未提交的 UCI 修改；禁止应用。',blocked_mismatch:'运行后端版本与已验证基线不一致；禁止快捷应用。',blocked_unknown:'无法确认运行状态；禁止应用。'};
        wp72Gate.textContent=dict[verdict]||dict.blocked_unknown;
        if(reason)wp72Gate.setAttribute('title',reason);
        wp72Gate.style.borderColor=verdict==='idle'?'#9bd4ba':'#efb9b9';
      }).catch(function(){wp72Gate.textContent='只读协调器不可用；保持现有安全应用流程，禁止快捷应用。';wp72Gate.style.borderColor='#efb9b9';});
    }
    window.setTimeout(wp72UpdateGate,500);
    var wp71RefreshButton=E('button',{'type':'button','class':'btn cbi-button','click':function(ev){ev.preventDefault();return Promise.all([wp71Refresh(),wp72UpdateGate()]);}},'刷新应用状态（只读）');
    // Consolidated entry. It delegates to the already tested guarded handlers,
    // NEVER runs two independent apply transactions or confirms automatically.
    var wpUnifiedActionBusy=false;
    var wpUnifiedActionStatus=E('div',{'role':'status','style':'color:#475569;font-size:13px;margin-top:8px'},'修改后点击一次即可保存、应用并自动确认；失败时仍由回滚保护恢复原配置。');
    var wpUnifiedActionScope=E('select',{'class':'cbi-input-select','aria-label':'应用范围','style':'min-width:180px'},[
      E('option',{'value':'auto'},'自动识别（推荐）'),
      E('option',{'value':'global'},'默认流量比例'),
      E('option',{'value':'device'},'设备线路规则')
    ]);
    var wpUnifiedActionButton=E('button',{'type':'button','class':'btn cbi-button-action',
      'click':function(ev){
        ev.preventDefault();
        if(wpUnifiedActionBusy)return;
        wpUnifiedActionBusy=true;wpUnifiedActionButton.disabled=true;
        wpUnifiedActionStatus.textContent='正在核查设备、全局事务及后台版本…';
        return Promise.all([
          fs.exec('/usr/libexec/wanpilot-safe',['status']),
          fs.exec('/usr/libexec/wanpilot-global-safe',['status']),
          fs.exec('/usr/libexec/wanpilot-coordinator',['inspect'])
        ]).then(function(rs){
          if(rs.some(function(r){return r.code!==0;}))throw Error('安全后端状态读取失败');
          var d=wp71StatusValue(rs[0].stdout,'pending'),g=wp71StatusValue(rs[1].stdout,'pending');
          var verdict=wp71StatusValue(rs[2].stdout,'verdict');
          if(d!=='no'||g!=='no'||verdict!=='idle')throw Error('当前存在待确认事务、暂存修改或后端不兼容；请查看诊断日志');
          // One-click global path: save the draft, re-open the transaction gate,
          // and re-read the live diff before invoking the original guarded handler.
          // Device edits retain their existing protected form workflow.
          var selected=wpUnifiedActionScope.value;
          if(selected==='auto' && wpDeviceHasUnsavedSelections() && Number(globalSlider.value)!==desiredWan)
            throw Error('全局比例与设备线路同时存在未保存编辑，请分别保存；未执行网络应用');
          function verifyDeviceCleanForGlobal(){
            return fs.exec('/usr/libexec/wanpilot-safe',['check']).then(function(devicePre){
              var output=String((devicePre.stdout||'')+'\n'+(devicePre.stderr||''));
              if(devicePre.code!==0||!/READY PASS:/.test(output)||!/STAGE PASS:/.test(output))
                throw Error('设备候选状态不可确定，禁止自动发布全局比例');
              var original=output.match(/Original SHA256:\s*([0-9a-f]{64})/i);
              var candidate=output.match(/Candidate SHA256:\s*([0-9a-f]{64})/i);
              if(!original||!candidate)throw Error('设备候选指纹缺失，禁止自动发布');
              if(original[1].toLowerCase()!==candidate[1].toLowerCase())
                throw Error('全局比例与设备规则同时待发布；请分别处理');
            });
          }
          function freshGlobalPublish(expectedDraft){
            return Promise.all([
              fs.exec('/usr/libexec/wanpilot-safe',['status']),
              fs.exec('/usr/libexec/wanpilot-global-safe',['status']),
              fs.exec('/usr/libexec/wanpilot-coordinator',['inspect']),
              readFreshTarget(),
              fs.exec('/usr/libexec/wanpilot-v25-diff',[])
            ]).then(function(checks){
              if(checks[0].code!==0||checks[1].code!==0||checks[2].code!==0||checks[4].code!==0)
                throw Error('保存后安全检查失败，未执行应用');
              if(wp71StatusValue(checks[0].stdout,'pending')!=='no'||
                 wp71StatusValue(checks[1].stdout,'pending')!=='no'||
                 wp71StatusValue(checks[2].stdout,'verdict')!=='idle')
                throw Error('保存后事务状态异常，未执行应用');
              if(checks[3]!==expectedDraft||Number(globalSlider.value)!==expectedDraft)
                throw Error('目标比例在保存后发生变化，未执行应用');
              var raw=String(checks[4].stdout||'');
              var live=raw.match(/当前\s*balanced\s*[:：]\s*([^\n]+)/i);
              var saved=raw.match(/已保存目标\s*[:：]\s*WAN\s*(\d+)%\s*\/\s*WAN1\s*(\d+)%/i);
              var wan=live&&live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
              var wan1=live&&live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
              if(!wan||!wan1||!saved)throw Error('保存后无法解析实时比例，未执行应用');
              var a=Number(wan[1]),b=Number(wan1[1]),c=Number(saved[1]),d=Number(saved[2]);
              if(a+b!==100||c+d!==100||c!==expectedDraft||d!==100-expectedDraft)
                throw Error('保存后实时比例校验失败，未执行应用');
              if(a===c&&b===d){
                wpUnifiedActionStatus.textContent='目标已经生效：WAN '+c+'% / WAN1 '+d+'%；无需再次应用。';
                return;
              }
              wpUnifiedActionStatus.textContent='目标已保存并复核通过，正在核查设备是否也存在未发布变更…';
              return (selected==='auto'?verifyDeviceCleanForGlobal():Promise.resolve()).then(function(){
                wpUnifiedActionStatus.textContent='正在应用全局比例 '+a+'/'+b+' → '+c+'/'+d+' 并自动确认…';
                return wpApplyAndConfirm('global');
              }).then(function(){
                wpUnifiedActionStatus.textContent='全局比例已保存、应用并确认生效：WAN '+c+'% / WAN1 '+d+'%。';
                return Promise.all([wp71Refresh(),wp72UpdateGate(),refreshGlobalState(true),refreshPublishSummary()]);
              });
            });
          }
          if(selected!=='device' && Number(globalSlider.value)!==desiredWan){
            var draft=Number(globalSlider.value);
            if(!Number.isInteger(draft)||draft<5||draft>95||draft%5!==0)
              throw Error('目标权重超出范围，未保存');
            wpUnifiedActionStatus.textContent='正在核对并保存目标比例…';
            return readFreshTarget().then(function(fresh){
              if(fresh!==desiredWan){
                desiredWan=fresh;refreshTargetSaveState();
                throw Error('其他管理窗口已修改目标比例，请核对后重试；未覆盖现有配置');
              }
              return fs.exec('/usr/libexec/wanpilot-v17',['save-target',String(draft)]);
            }).then(function(saved){
              if(saved.code!==0)throw Error('保存目标比例失败：'+(saved.stderr||saved.stdout||saved.code));
              return readFreshTarget();
            }).then(function(actual){
              if(actual!==draft)throw Error('目标比例保存后复核不一致，禁止应用');
              desiredWan=draft;refreshTargetSaveState();
              wpUnifiedActionStatus.textContent='目标已保存，正在重新检查安全事务与配置差异…';
              return freshGlobalPublish(draft);
            });
          }
          // Device publishing is authorized by the device backend's freshly generated
          // candidate, never by a global-weight diff or a cached UI comparison.
          // Always re-read after persistence; do not trust a cached candidate.
          function publishDeviceFresh(){
            if(wpDeviceHasUnsavedSelections())
              throw Error('设备线路存在尚未保存的下拉框修改。请先保存对应设备线路，随后再应用；本次未发布旧配置');
            if(Number(globalSlider.value)!==desiredWan)
              throw Error('全局比例存在未保存的编辑，请先完成该项设置；不允许混合应用');
            wpUnifiedActionStatus.textContent='正在进行设备规则只读预检…';
            return fs.exec('/usr/libexec/wanpilot-safe',['check']).then(function(pre){
              var output=String((pre.stdout||'')+'\n'+(pre.stderr||''));
              if(pre.code!==0 || !/READY PASS:/.test(output) || !/STAGE PASS:/.test(output))
                throw Error('设备安全预检失败；不执行网络应用');
              var original=output.match(/Original SHA256:\s*([0-9a-f]{64})/i);
              var candidate=output.match(/Candidate SHA256:\s*([0-9a-f]{64})/i);
              if(!original||!candidate)throw Error('设备预检未提供完整配置指纹');
              if(original[1].toLowerCase()===candidate[1].toLowerCase()){
                wpUnifiedActionStatus.textContent='设备配置无变化，无需再次应用或重启网络。';
                return;
              }
              return Promise.all([
                fs.exec('/usr/libexec/wanpilot-safe',['status']),
                fs.exec('/usr/libexec/wanpilot-global-safe',['status']),
                fs.exec('/usr/libexec/wanpilot-coordinator',['inspect'])
              ]).then(function(again){
                if(again.some(function(r){return r.code!==0;}) ||
                  wp71StatusValue(again[0].stdout,'pending')!=='no' ||
                  wp71StatusValue(again[1].stdout,'pending')!=='no' ||
                  wp71StatusValue(again[2].stdout,'verdict')!=='idle')
                  throw Error('设备预检后事务状态已变化，已取消应用');
                wpUnifiedActionStatus.textContent='设备规则已复核，正在应用并自动确认…';
                return wpApplyAndConfirm('device').then(function(){
                  wpUnifiedActionStatus.textContent='设备线路已保存、应用并确认生效。';
                  return Promise.all([wp71Refresh(),wp72UpdateGate(),refreshSafety(),refreshPublishSummary()]);
                });
              });
            });
          }

          // Batch-save device selections with the existing backend, then publish ONCE.
          // This is sequential persistence, not an atomic batch transaction. On any
          // failure stop before touching live mwan3 and report partial saves.
          function saveDeviceDraftsAndPublish(){
            var drafts=wpDeviceEditBaselines.filter(function(item){return item.control.value!==item.original;});
            if(!drafts.length)return publishDeviceFresh();
            // Preserve all selections during sequential saves, so the displayed
            // pending count always reflects the actual remaining edits.
            if(Number(globalSlider.value)!==desiredWan)
              throw Error('同时存在全局比例修改，请分开应用全局比例和设备设置');
            var seen={},jobs=drafts.map(function(item){
              var ip=item.ip,choice=item.control.value;
              if(seen[ip])throw Error('设备 '+ip+' 存在多个编辑项，已停止批量保存');
              seen[ip]=true;
              if(item.conflict || !/^192\.168\.188\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(ip))
                throw Error('设备 '+ip+' 的地址或高级规则有冲突，未开始保存');
              if(['default','wan','wan1','balance','failover'].indexOf(choice)<0)
                throw Error('设备 '+ip+' 的线路选择无效，未开始保存');
              return {item:item,ip:ip,choice:choice,args:choice==='default'?['remove-device',ip]:['assign-device',ip,choice]};
            });
            var completed=[];
            function next(index){
              if(index===jobs.length){
                // A user may change a select while a backend save request is pending.
                // Never publish an older selection when new unsaved edits exist.
                if(wpDeviceHasUnsavedSelections())
                  throw Error('保存过程中设备选择发生了变化；已保存 '+completed.length+' 台，剩余修改尚未应用，请再次点击「保存并应用」');
                wpUnifiedActionStatus.textContent='已保存 '+completed.length+' 台设备，正在重新检查规则并应用…';
                return publishDeviceFresh();
              }
              var job=jobs[index];
              if(job.item.control.value!==job.choice)
                throw Error('设备编辑内容发生变化，已保存 '+completed.length+' 台；未执行网络应用，请刷新核对');
              wpUnifiedActionStatus.textContent='保存设备 '+(index+1)+' / '+jobs.length+'：'+job.ip;
              return fs.exec('/usr/libexec/wanpilot',job.args).then(function(result){
                if(result.code!==0)
                  throw Error('保存 '+job.ip+' 失败；已保存 '+completed.length+' 台（'+completed.join('、')+'），未执行网络应用：'+(result.stderr||result.stdout||result.code));
                completed.push(job.ip);
                job.item.original=job.choice;
                cardMeta.forEach(function(meta){
                  if(meta.ip!==job.ip)return;
                  meta.configured=job.choice!=='default';
                  meta.configuredBadge.textContent=meta.configured?'已单独设置':'默认上网';
                  meta.configuredBadge.className='wp61-status'+(meta.configured?' is-configured':'');
                  meta.routeLabel.textContent=job.choice==='default'?'自动使用默认线路':outletLabel(job.choice);
                });
                // A saved device is no longer a draft. Update its badge and
                // the pending count without waiting for a page reload.
                filterDeviceRows();
                return next(index+1);
              });
            }
            return next(0);
          }
          if(selected==='device' && wpDeviceHasUnsavedSelections())return saveDeviceDraftsAndPublish();
          if(selected==='device')return publishDeviceFresh();
          // A fresh read-only diff is mandatory; cached slider values cannot authorize apply.
          return fs.exec('/usr/libexec/wanpilot-v25-diff',[]).then(function(diff){
            if(diff.code!==0)throw Error('无法读取实时配置差异，未执行应用');
            var raw=String(diff.stdout||'');
            var live=raw.match(/当前\s*balanced\s*[:：]\s*([^\n]+)/i);
            var targetRatio=raw.match(/已保存目标\s*[:：]\s*WAN\s*(\d+)%\s*\/\s*WAN1\s*(\d+)%/i);
            var wan=live&&live[1].match(/(?:^|\s)wan\s*\(\s*(\d+)%\s*\)/i);
            var wan1=live&&live[1].match(/(?:^|\s)wan1\s*\(\s*(\d+)%\s*\)/i);
            if(!wan||!wan1||!targetRatio)throw Error('比例差异不明确，禁止应用');
            var a=Number(wan[1]),b=Number(wan1[1]),c=Number(targetRatio[1]),d=Number(targetRatio[2]);
            if(a+b!==100||c+d!==100)throw Error('比例数据不合法，禁止应用');
            var globalChanged=a!==c||b!==d;
            if(Number(globalSlider.value)!==c)throw Error('滑块还有未保存的修改，请先保存目标比例');
            if(selected==='auto' && wpDeviceHasUnsavedSelections()){
              if(globalChanged)throw Error('存在未发布的全局比例差异，拒绝同时保存设备草稿');
              return saveDeviceDraftsAndPublish();
            }
            if(selected==='auto'&&!globalChanged){
              // Device preflight is authoritative even when the global ratio is unchanged.
              // The device publisher performs a second status and hash check before applying.
              return publishDeviceFresh();
            }
            if(selected==='auto'&&globalChanged){
              return verifyDeviceCleanForGlobal().then(function(){
                wpUnifiedActionStatus.textContent='设备规则无待发布变更；正在应用全局比例并自动确认…';
                return wpApplyAndConfirm('global');
              }).then(function(){
                wpUnifiedActionStatus.textContent='全局比例已保存、应用并确认生效。';
                return Promise.all([wp71Refresh(),wp72UpdateGate(),refreshGlobalState(true),refreshPublishSummary()]);
              });
            }
            if(selected==='global'&&!globalChanged){wpUnifiedActionStatus.textContent='全局比例已一致，未重新应用或重启网络。';return;}
            wpUnifiedActionStatus.textContent='检测到全局比例 '+a+'/'+b+' → '+c+'/'+d+'，正在应用并自动确认…';
            return wpApplyAndConfirm('global').then(function(){
              wpUnifiedActionStatus.textContent='全局比例已保存、应用并确认生效。';
              return Promise.all([wp71Refresh(),wp72UpdateGate(),refreshGlobalState(true),refreshPublishSummary()]);
            });
          });
        }).catch(function(err){
          wpUnifiedActionStatus.textContent='没有执行应用：'+String(err);
          ui.addNotification(null,E('p',{},String(err)),'danger');
        }).finally(function(){wpUnifiedActionBusy=false;wpUnifiedActionButton.disabled=false;});
      }
    },'保存并应用');
    var wpUnifiedActionCard=E('div',{'class':'cbi-section wp122-save-card'},[
      E('div',{'class':'wp122-save-copy'},[
        E('h3',{},'保存并应用'),
        E('p',{},'修改比例或设备线路后点击一次；无变化不会重复应用。'),
        E('div',{'class':'wp122-save-status'},[wpUnifiedActionStatus])
      ]),
      E('div',{'class':'wp122-save-action'},[wpUnifiedActionButton])
    ]);
    // Routine editing stays compact; keep protected confirm/rollback accessible.
    // Debug outputs are reparented to the diagnostics tab, without destroying their IDs.
    // Keep the already-wired slider in the routine page; move its old standalone
    // save/preview controls to diagnostics instead of duplicating Save & Apply.
    var simpleBalance=E('div',{'class':'cbi-section','style':'padding:22px 24px;border:1px solid #d7e2ef;border-radius:14px;margin:14px 0;background:#fff'},[
      E('div',{'style':'display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px'},[
        E('div',{},[
          E('h3',{'style':'margin:0 0 6px;font-size:18px;line-height:1.35'},'默认流量分担比例'),
          E('div',{'style':'font-size:13px;color:#64748b'},'两条线路都正常时，按此比例分配普通设备的新连接。')
        ]),
        E('div',{'class':'wp124-ratio-legend'},[E('span',{'class':'wp124-chip-wan'},'WAN'),globalValue,E('span',{'class':'wp124-chip-wan1'},'WAN1')])
      ]),
      E('div',{'style':'padding:6px 2px 2px'},[globalSlider])
    ]);
    var failoverStatus=E('div',{'style':'font-size:12px;color:#64748b;margin-top:8px'},deviceFailoverEnabled?'已开启：指定设备的首选线路离线时，会自动使用另一条在线线路。':'已关闭：指定 WAN/WAN1 的设备严格固定线路，故障时不会自动换线。');
    var failoverButton=E('button',{'type':'button','class':'btn cbi-button-action','click':function(ev){
      ev.preventDefault();
      var target=deviceFailoverEnabled?'0':'1';
      var action=target==='1'?'开启':'关闭';
      failoverButton.disabled=true;
      failoverStatus.textContent='正在'+action+'并安全应用…';
      return fs.exec('/usr/libexec/wanpilot',['device-failover-set',target]).then(function(r){
        if(!r||r.code!==0)throw Error((r&&(r.stderr||r.stdout))||'设置保存失败');
        return wpApplyAndConfirm('device');
      }).then(function(){
        failoverStatus.textContent=action+'成功，正在刷新…';
        window.location.reload();
      }).catch(function(err){
        failoverStatus.textContent=action+'未完成：'+String(err);
        ui.addNotification(null,E('p',{},'线路故障保护'+action+'失败：'+String(err)),'danger');
        failoverButton.disabled=false;
      });
    }},deviceFailoverEnabled?'关闭自动切换':'开启自动切换');
    var failoverWanHealth=E('strong',{},'读取中');
    var failoverWan1Health=E('strong',{},'读取中');
    var failoverHealthNote=E('div',{'style':'font-size:12px;color:#64748b;margin-top:8px'},'线路健康状态直接读取 mwan3，不额外发起 Ping。');
    function refreshFailoverHealth(){
      return fs.exec('/usr/libexec/wanpilot',['snapshot']).then(function(r){
        if(!r||r.code!==0)throw Error('snapshot failed');
        var seen={};
        String(r.stdout||'').split(/\r?\n/).slice(1).forEach(function(line){
          var c=line.split('|');
          if(c.length>=2&&(c[0]==='wan'||c[0]==='wan1'))seen[c[0]]=c[1];
        });
        function paint(node,state){
          node.textContent=state==='online'?'● 在线':state==='offline'?'● 离线':'状态未知';
          node.style.color=state==='online'?'#15803d':state==='offline'?'#b91c1c':'#64748b';
        }
        paint(failoverWanHealth,seen.wan); paint(failoverWan1Health,seen.wan1);
      }).catch(function(){
        failoverWanHealth.textContent='状态未知'; failoverWanHealth.style.color='#64748b';
        failoverWan1Health.textContent='状态未知'; failoverWan1Health.style.color='#64748b';
      });
    }
    refreshFailoverHealth();
    var failoverStateBadge=E('span',{'style':'display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;background:'+(deviceFailoverEnabled?'#dcfce7':'#f1f5f9')+';color:'+(deviceFailoverEnabled?'#166534':'#475569')},deviceFailoverEnabled?'已开启':'已关闭');
    function healthBox(title,node,subtitle,line){
      return E('div',{'class':'wp124-health wp124-health-'+line,'style':'flex:1 1 220px;min-width:200px;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#f8fafc'},[
        E('div',{'style':'font-size:12px;color:#64748b;margin-bottom:5px'},title),
        E('div',{'style':'font-size:16px;font-weight:700;line-height:1.4'},[node]),
        E('div',{'style':'font-size:12px;color:#94a3b8;margin-top:4px'},subtitle)
      ]);
    }
    var failoverCard=E('div',{'class':'cbi-section','style':'padding:22px 24px;border:1px solid #d7e2ef;border-radius:14px;margin:14px 0;background:#fff'},[
      E('div',{'style':'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px'},[
        E('div',{},[
          E('h3',{'style':'margin:0 0 6px;font-size:18px;line-height:1.35'},'线路故障保护'),
          E('div',{'style':'font-size:13px;color:#64748b;max-width:780px;line-height:1.7'},deviceFailoverEnabled?'首选线路被 mwan3 判定离线时自动切换到另一条在线线路；恢复后自动回到首选线路。':'关闭后，指定 WAN/WAN1 的设备将严格固定线路，线路故障时不会自动换线。')
        ]),
        failoverStateBadge
      ]),
      E('div',{'style':'display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px'},[
        healthBox('WAN 主线路',failoverWanHealth,'健康状态由 mwan3 提供','wan'),
        healthBox('WAN1 第二线路',failoverWan1Health,'健康状态由 mwan3 提供','wan1')
      ]),
      E('div',{'style':'display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding-top:14px;border-top:1px solid #eef2f7'},[
        E('div',{'style':'font-size:13px;color:#64748b;line-height:1.7;flex:1 1 420px'},[failoverStatus,failoverHealthNote]),
        E('div',{'style':'flex:0 0 auto'},[failoverButton])
      ])
    ]);
    var deviceWorkspace=E('div',{'class':'wp7-device-workspace'},[
      simpleBalance,
      failoverCard,
      devicePanel,
      wpUnifiedActionCard
    ]);
    diagnostics.appendChild(E('details',{'style':'margin:10px 0;padding:10px;border:1px solid #d7e2ef;border-radius:8px'},[
      E('summary',{},'旧版比例保存与预览（仅排错时使用）'),v17Card
    ]));
    // Keep legacy protected operations available for pending transactions,
    // but remove duplicate apply/confirm controls from the routine device page.
    diagnostics.appendChild(E('details',{'style':'margin:10px 0;padding:10px;border:1px solid #d7e2ef;border-radius:8px'},[
      E('summary',{},'安全应用与手动恢复（仅在需要时使用）'),protectedOperations
    ]));
    // The recovery entry is mounted once in the main diagnostics area.
    // Use the installed LuCI mwan3 editor for complete low-level management.
    // This is a navigation link only; it does not read, save, or apply settings.
    var nativeMwan3Entry=E('div',{'class':'cbi-section wp123-advanced-card'},[
      E('div',{'class':'wp123-advanced-top'},[
        E('div',{'class':'wp123-advanced-icon'},'M'),
        E('div',{'class':'wp123-advanced-copy'},[
          E('div',{'class':'wp123-eyebrow'},'ADVANCED ROUTING'),
          E('h3',{},'mwan3 原生高级管理'),
          E('p',{},'接口、成员、策略、规则及线路健康检测等完整功能，继续由 mwan3 原生管理器负责。WanPilot 只保留日常双 WAN 比例、设备分流与故障保护。')
        ]),
        E('a',{'class':'btn cbi-button-action wp123-open-mwan3','href':L.url('admin/network/mwan3'),'target':'_blank','rel':'noopener noreferrer'},'打开 mwan3 管理器 ↗')
      ]),
      E('div',{'class':'wp123-advanced-notice'},[
        E('strong',{},'使用提示'),
        E('span',{},'高级设置与 WanPilot 操作分开保存。编辑同一项策略时，请不要同时打开两个页面修改。')
      ]),
      E('div',{'class':'wp123-advanced-foot'},'如果入口无法打开，请在 iStoreOS 应用管理中确认已安装 luci-app-mwan3。')
    ]);
    // Keep the normal user-facing advanced page simple and avoid a second save model.
    // Complete low-level editing stays in the native mwan3 manager.
    var advancedPage=E('div',{},[nativeMwan3Entry]);
    diagnostics.appendChild(E('details',{'style':'margin:10px 0;padding:10px;border:1px solid #d7e2ef;border-radius:8px'},[
      E('summary',{},'故障排查：手动选择应用范围'),wpUnifiedActionScope
    ]));
    diagnostics.appendChild(E('div',{'class':'cbi-section'},[
      E('h3',{},'应用事务与兼容性诊断'),
      wp71Notice,wp72Gate,wp71RefreshButton
    ]));
    var tabs=[
      ['overview','网络总览','线路状态、速度与趋势',summary],
      ['devices','设备分流','线路比例、设备选择、保存并应用',deviceWorkspace],
      ['advanced','高级设置','使用 mwan3 原生管理器进行完整规则编辑',advancedPage],
      ['diagnostics','诊断日志','运行统计、事务状态与排错',diagnostics]
    ];
    // Automatic retention is now part of normal Save & Apply; no hidden toggle.
    // Keep the diagnostic page focused: status and recovery first.
    // Legacy controls remain mounted in one collapsed group so existing
    // event handlers, pending confirmations and fallback actions still work.
    var diagnosticsLegacy=E('details',{'class':'wp7-diagnostic-legacy','style':'margin:12px 0;padding:12px;border:1px solid #d7e2ef;border-radius:10px'},[
      E('summary',{'style':'cursor:pointer;font-weight:600'},'详细诊断与维护操作'),
      E('p',{'style':'font-size:13px;color:#64748b'},'只有遇到问题时才需要展开。')
    ]);
    Array.prototype.slice.call(diagnostics.childNodes).forEach(function(child){
      if(child!==stableRuntime && child!==stableRecent && child!==stableRecovery)
        diagnosticsLegacy.appendChild(child);
    });
    // Stable diagnostics: concise read-only status first. Keep legacy nodes hidden below.
    var diagWan=E('strong',{},'读取中');
    var diagWan1=E('strong',{},'读取中');
    var diagMwan3=E('strong',{},'读取中');
    function diagStateBox(title,node){
      return E('div',{'style':'flex:1 1 190px;min-width:180px;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#f8fafc'},[
        E('div',{'style':'font-size:12px;color:#64748b;margin-bottom:5px'},title),
        E('div',{'style':'font-size:16px;font-weight:700'},[node])
      ]);
    }
    function diagPaint(node,state){
      node.textContent=state==='online'?'● 在线':state==='offline'?'● 离线':'状态未知';
      node.style.color=state==='online'?'#15803d':state==='offline'?'#b91c1c':'#64748b';
    }
    function refreshStableDiagnostics(){
      return fs.exec('/usr/libexec/wanpilot',['snapshot']).then(function(r){
        if(!r||r.code!==0)throw Error('snapshot failed');
        var seen={};
        String(r.stdout||'').split(/\r?\n/).slice(1).forEach(function(line){
          var c=line.split('|');
          if(c.length>=2&&(c[0]==='wan'||c[0]==='wan1'))seen[c[0]]=c[1];
        });
        diagPaint(diagWan,seen.wan); diagPaint(diagWan1,seen.wan1);
        diagMwan3.textContent='● 正常';
        diagMwan3.style.color='#15803d';
      }).catch(function(){
        diagPaint(diagWan); diagPaint(diagWan1);
        diagMwan3.textContent='状态未知'; diagMwan3.style.color='#64748b';
      });
    }
    var stableRuntime=E('div',{'class':'cbi-section'},[
      E('h3',{},'运行状态'),
      E('div',{'style':'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px'},[
        diagStateBox('WAN 主线路',diagWan),diagStateBox('WAN1 第二线路',diagWan1),diagStateBox('mwan3',diagMwan3)
      ]),
      E('div',{'style':'display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:#475569'},[
        E('span',{'style':'padding:6px 10px;border-radius:999px;background:'+(deviceFailoverEnabled?'#dcfce7':'#f1f5f9')+';color:'+(deviceFailoverEnabled?'#166534':'#475569')},'故障保护：'+(deviceFailoverEnabled?'已开启':'已关闭')),
        E('span',{'style':'padding:6px 10px;border-radius:999px;background:#f1f5f9'},'默认比例：WAN '+desiredWan+'% / WAN1 '+(100-desiredWan)+'%')
      ])
    ]);
    diagnostics.appendChild(stableRuntime);
    var stableRecent=E('div',{'class':'cbi-section'},[
      E('h3',{},'最近操作'),
      wp71Notice,wp72Gate,
      E('p',{'style':'font-size:12px;color:#64748b;margin:8px 0 0'},'这里仅显示当前事务状态。完整技术信息保留在隐藏兼容层中，不影响日常操作。')
    ]);
    diagnostics.appendChild(stableRecent);
    var stableRecovery=E('div',{'class':'cbi-section'},[
      E('h3',{},'应急恢复'),
      E('p',{},'仅在修改网络配置后出现异常、无法确认或需要恢复旧配置时使用。'),
      recoveryShortcut
    ]);
    diagnostics.appendChild(stableRecovery);
    refreshStableDiagnostics();
    // Keep legacy nodes mounted for compatibility with existing handlers, but do not
    // expose historical development controls in the normal diagnostics UI.
    diagnosticsLegacy.style.display='none';
    diagnostics.appendChild(diagnosticsLegacy);
    var nav=E('div',{'class':'wp6-nav'});
    var pageHeading=E('div',{'id':'wp-v23-heading','class':'wp6-heading'},'');
    var panels=[];
    function switchTab(key){
      tabs.forEach(function(t,i){
        var active=t[0]===key;
        panels[i].style.display=active?'block':'none';
        nav.children[i].className='btn '+(active?'cbi-button-action':'cbi-button');
        nav.children[i].setAttribute('aria-pressed',String(active));
      });
      // Resolve within this view: global document lookup may be empty before mounting.
      var heading=pageHeading;
      var selected=tabs.filter(function(t){return t[0]===key;})[0];
      if(heading&&selected)heading.textContent=selected[1]+' · '+selected[2];
      // Update the newly opened panel immediately; scheduled refresh remains unchanged.
      // Read-only calls only. Never trigger save/apply during navigation.
      if(root && root.isConnected){
        if(key==='overview'){
          Promise.resolve().then(function(){return poll();}).catch(function(){});
        } else if(key==='diagnostics'){
          Promise.resolve().then(function(){return refreshSafety();}).catch(function(){});
          Promise.resolve().then(function(){return refreshGlobalState();}).catch(function(){});
          Promise.resolve().then(function(){return wp71Refresh();}).catch(function(){});
          Promise.resolve().then(function(){return refreshStableDiagnostics();}).catch(function(){});
        }
      }
      // V4.9: always refresh read-only publish data on entering the release tab.
      // Do not invoke any write, check-as-apply, or configuration save operation.
      if(key==='devices' && root && root.isConnected && root.querySelector('#wp-v25-publish-summary')){
        if(guideScope.value==='device')updateDeviceComparisonVisibility();
        // A failed read-only refresh must not prevent navigation or cause an unhandled rejection.
        [refreshPublishSummary,refreshReleaseBanner,refreshWizard].forEach(function(fn){
          Promise.resolve().then(function(){ return fn(); }).catch(function(){});
        });
      }
    }
    tabs.forEach(function(t){
      nav.appendChild(E('button',{'type':'button','class':'btn cbi-button','aria-pressed':'false','click':function(e){e.preventDefault();switchTab(t[0]);}},t[1]));
      panels.push(E('div',{'data-wp-tab':t[0],'class':'wp6-panel'},t[3]));
    });
    // V6.5: consolidated next-action status remains read-only and never grants permission.
    root=E('div',{'class':'wp6-app'},[
      E('style',{},'/* WanPilot V6.5 — readable status and compact action steps */\n.wp6-app .wp62-wizard{max-width:900px;margin:0 auto 16px!important}\n.wp6-app .wp62-wizard-tools{display:flex;flex-wrap:wrap;gap:10px}\n.wp6-app .wp62-wizard-tools .btn{width:auto!important;min-width:180px}\n.wp6-app .wp62-wizard [id=wp52-phase]{border-left:4px solid #5b70e8!important;font-size:15px!important}\n/* WanPilot V6 — unified visual language, display-only */\n.wp6-app{--wp6-border:#e3e8f0;--wp6-ink:#1e2940;--wp6-muted:#64748b;--wp6-bg:#f6f8fc;color:var(--wp6-ink);font-size:14px;line-height:1.55;max-width:1600px;margin:0 auto}\n.wp6-app *{box-sizing:border-box}\n.wp6-app .wp6-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;padding:22px 24px;border-radius:16px;background:#fff;border:1px solid var(--wp6-border);margin-bottom:12px}\n.wp6-app .wp6-brand{font-weight:750;font-size:25px;letter-spacing:-.5px;color:#222e52}\n.wp6-app .wp6-subtitle{font-size:13px;color:var(--wp6-muted);margin-top:3px}\n.wp6-app .wp6-safe-tag{padding:6px 12px;color:#166534;background:#e8f7ec;border-radius:999px;font-size:12px;font-weight:650}\n.wp6-app .wp6-nav{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0 16px;border:0!important;margin:0 0 16px!important}\n.wp6-app .wp6-nav .btn{min-height:39px;padding:9px 16px!important;border:1px solid #e1e6ef!important;border-radius:11px!important;background:#fff!important;color:#39465c!important;box-shadow:none!important;font-weight:600;font-size:13px}\n.wp6-app .wp6-nav .cbi-button-action{background:#586de5!important;border-color:#586de5!important;color:#fff!important;box-shadow:0 3px 9px #586de52b!important}\n.wp6-app .wp6-heading{font-size:19px;font-weight:750;color:#233153;margin:10px 2px 16px!important}\n.wp6-app .wp6-panel>.cbi-section,.wp6-app .wp6-panel>.wp6-card{background:#fff;border:1px solid var(--wp6-border)!important;border-radius:16px!important;padding:20px!important;margin:0 0 16px!important;box-shadow:0 2px 10px #1a2b5110}\n.wp6-app .wp6-panel>.cbi-section h2,.wp6-app .wp6-panel>.cbi-section h3,.wp6-app .wp6-panel>.wp6-card h2,.wp6-app .wp6-panel>.wp6-card h3{margin:0 0 13px;color:#253258;font-size:18px;line-height:1.45}\n.wp6-app .wp6-panel p{line-height:1.65;color:#65738a;font-size:13px}\n.wp6-app .wp6-panel .btn{border-radius:10px!important;min-height:36px;padding:8px 13px!important;white-space:normal}\n.wp6-app .wp6-panel .cbi-button-action{background:#5b70e8!important;border-color:#5b70e8!important;color:#fff!important}\n.wp6-app .wp6-panel .btn:disabled{opacity:.53!important;cursor:not-allowed}\n.wp6-app .wp6-panel table{width:100%;border-collapse:collapse;font-size:13px}\n.wp6-app .wp6-panel table th{background:#f6f8fc;color:#64748b;font-size:12px;text-align:left;padding:12px 14px;border-bottom:1px solid var(--wp6-border)}\n.wp6-app .wp6-panel table td{padding:13px 14px;border-bottom:1px solid #eef1f6;vertical-align:middle}\n.wp6-app .wp6-panel table tr:last-child td{border-bottom:0}\n.wp6-app .wp6-panel input,.wp6-app .wp6-panel select{border:1px solid #dce2ed;border-radius:9px;min-height:36px;background:#fff}\n.wp6-app .wp6-panel details{border-radius:11px}\n.wp6-app .wp6-panel details>summary{cursor:pointer;color:#455471;font-size:13px}\n.wp6-app .wp6-panel pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #e7ebf3;background:#f7f9fc;border-radius:10px;padding:12px;font-size:12px}\n.wp6-app .wp6-panel [id=wp-v30-release-state],.wp6-app .wp6-panel [id=wp58-device-state],.wp6-app .wp6-panel [id=wp52-phase]{border-radius:10px!important;padding:13px!important}\n.wp6-app .wp6-panel [id=wp52-phase]{font-size:14px}\n.wp6-app .wp6-panel [id=wp31-current],.wp6-app .wp6-panel [id=wp31-target]{font-size:25px!important}\n.wp6-app .wp6-panel [id=wp56-device-compare-area]{border-radius:12px!important}\n.wp6-app .wp6-panel [id=wp56-device-compare-area] button{width:auto!important;max-width:100%}\n.wp6-app .wp6-panel [id=wp50-next-action]{border-radius:10px!important}\n.wp6-app .wp6-panel [id=wp-v26-audit-result]{max-height:270px}\n.wp6-app .wp6-panel .wp6-section-label{color:#7b879b;font-size:12px;letter-spacing:.04em;font-weight:700;text-transform:uppercase;margin:0 0 6px}\n.wp6-app .wp6-panel .wp6-section-note{font-size:13px;color:#65738a;margin-bottom:16px}\n.wp6-app .wp6-panel .wp6-hero-note{border:1px solid #d9e6fb;background:#f6f9ff;border-radius:12px;padding:12px 14px;font-size:13px;color:#38547c;margin-bottom:14px}\n.wp6-app .wp6-panel[data-wp-tab=overview]> .cbi-section:first-child{padding:20px!important}\n.wp6-app .wp6-panel[data-wp-tab=safety]> .cbi-section{border:0!important;padding:0!important;box-shadow:none;background:transparent}\n.wp6-app .wp6-panel[data-wp-tab=safety] #wp52-phase{background:#f3f6fc}\n.wp6-app .wp6-panel[data-wp-tab=safety] details{background:#fff}\n.wp6-app .wp6-panel[data-wp-tab=devices] .cbi-section{padding:20px!important}\n/* WanPilot 1.2.3 — overview and advanced page polish; visual only */\n.wp6-app .wp123-overview-card{padding:24px!important}\n.wp6-app .wp123-overview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap;margin-bottom:18px}\n.wp6-app .wp123-overview-head h3{font-size:20px!important;margin:2px 0 5px!important}\n.wp6-app .wp123-overview-head p{margin:0!important}\n.wp6-app .wp123-eyebrow{font-size:11px;font-weight:800;letter-spacing:.09em;color:#7c8aa4;margin-bottom:3px}\n.wp6-app .wp123-overview-refresh{font-size:12px;color:#64748b;background:#f6f8fc;border:1px solid #e5eaf2;border-radius:999px;padding:7px 11px;white-space:nowrap}\n.wp6-app .wp123-line-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}\n.wp6-app .wp123-line-card{border:1px solid #e1e7f0;border-radius:14px;padding:18px;background:linear-gradient(180deg,#fbfcff 0%,#f7f9fd 100%)}\n.wp6-app .wp123-line-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px}\n.wp6-app .wp123-line-head>div:last-child{margin:0!important;font-size:12px!important;padding:5px 9px;border-radius:999px;background:#fff;border:1px solid #e4e9f1;white-space:nowrap}\n.wp6-app .wp123-line-label{font-size:12px;color:#7b879b;margin-bottom:1px}\n.wp6-app .wp123-line-name{font-size:20px;font-weight:800;color:#243154;letter-spacing:.02em}\n.wp6-app .wp123-speed{font-size:18px;font-weight:700;color:#263654;padding:11px 0;border-top:1px solid #e9edf4;border-bottom:1px solid #e9edf4;margin-bottom:11px}\n.wp6-app .wp123-speed>div{margin:0!important;font-size:16px!important}\n.wp6-app .wp123-meta{display:grid;gap:4px;min-height:58px}\n.wp6-app .wp123-trend{margin-top:12px;padding-top:4px}\n.wp6-app .wp123-overview-foot{margin-top:14px;font-size:12px;color:#7a879a}\n.wp6-app .wp123-advanced-card{padding:26px!important;overflow:hidden}\n.wp6-app .wp123-advanced-top{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:18px;align-items:center}\n.wp6-app .wp123-advanced-icon{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:#eef2ff;color:#586de5;font-size:22px;font-weight:850;border:1px solid #dfe5ff}\n.wp6-app .wp123-advanced-copy h3{font-size:20px!important;margin:1px 0 5px!important}\n.wp6-app .wp123-advanced-copy p{margin:0!important;max-width:880px}\n.wp6-app .wp123-open-mwan3{min-width:190px;text-align:center;text-decoration:none!important}\n.wp6-app .wp123-advanced-notice{display:flex;gap:10px;align-items:flex-start;margin-top:20px;padding:12px 14px;border-radius:11px;background:#f7f9fc;border:1px solid #e7ebf2;color:#5d6a7f;font-size:12px}\n.wp6-app .wp123-advanced-notice strong{color:#35425c;white-space:nowrap}\n.wp6-app .wp123-advanced-foot{font-size:12px;color:#8a96a8;margin-top:10px}\n/* WanPilot 1.2.4 — persistent WAN/WAN1 visual identity */\n.wp6-app{--wp124-wan:#2563eb;--wp124-wan-soft:#eff6ff;--wp124-wan-border:#bfdbfe;--wp124-wan1:#7c3aed;--wp124-wan1-soft:#f5f3ff;--wp124-wan1-border:#ddd6fe}\n.wp6-app .wp123-line-card{position:relative;overflow:hidden;border-top-width:4px!important}\n.wp6-app .wp124-line-wan{border-top-color:var(--wp124-wan)!important;background:linear-gradient(180deg,var(--wp124-wan-soft) 0%,#fff 34%,#f9fbff 100%)}\n.wp6-app .wp124-line-wan1{border-top-color:var(--wp124-wan1)!important;background:linear-gradient(180deg,var(--wp124-wan1-soft) 0%,#fff 34%,#fbfaff 100%)}\n.wp6-app .wp124-line-wan .wp123-line-name{color:var(--wp124-wan)}\n.wp6-app .wp124-line-wan1 .wp123-line-name{color:var(--wp124-wan1)}\n.wp6-app .wp124-line-wan .wp123-trend>div:first-child>div{background:var(--wp124-wan)!important;opacity:.72}\n.wp6-app .wp124-line-wan1 .wp123-trend>div:first-child>div{background:var(--wp124-wan1)!important;opacity:.72}\n.wp6-app .wp124-health{position:relative;overflow:hidden;padding-left:18px!important}\n.wp6-app .wp124-health:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px}\n.wp6-app .wp124-health-wan{background:var(--wp124-wan-soft)!important;border-color:var(--wp124-wan-border)!important}.wp6-app .wp124-health-wan:before{background:var(--wp124-wan)}\n.wp6-app .wp124-health-wan1{background:var(--wp124-wan1-soft)!important;border-color:var(--wp124-wan1-border)!important}.wp6-app .wp124-health-wan1:before{background:var(--wp124-wan1)}\n.wp6-app .wp61-route{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-weight:700;font-size:12px;white-space:nowrap}\n.wp6-app .wp124-route-wan{color:#1d4ed8;background:var(--wp124-wan-soft);border:1px solid var(--wp124-wan-border)}\n.wp6-app .wp124-route-wan1{color:#6d28d9;background:var(--wp124-wan1-soft);border:1px solid var(--wp124-wan1-border)}\n.wp6-app .wp124-route-balance{color:#475569;background:#f1f5f9;border:1px solid #e2e8f0}\n.wp6-app .wp124-route-default{color:#64748b;background:#f8fafc;border:1px solid #e5e7eb}\n.wp6-app .wp124-ratio-legend{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:#334155;white-space:nowrap}\n.wp6-app .wp124-chip-wan,.wp6-app .wp124-chip-wan1{font-size:11px;letter-spacing:.03em;padding:4px 7px;border-radius:999px}\n.wp6-app .wp124-chip-wan{color:#1d4ed8;background:var(--wp124-wan-soft);border:1px solid var(--wp124-wan-border)}\n.wp6-app .wp124-chip-wan1{color:#6d28d9;background:var(--wp124-wan1-soft);border:1px solid var(--wp124-wan1-border)}\n.wp6-app .wp124-ratio-slider{height:8px;border:0!important;border-radius:999px!important;appearance:none;-webkit-appearance:none;outline:none}.wp6-app .wp124-ratio-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;border:4px solid #5368e8;box-shadow:0 1px 5px #1e293b33;cursor:pointer}.wp6-app .wp124-ratio-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:4px solid #5368e8;box-shadow:0 1px 5px #1e293b33;cursor:pointer}\n@media(max-width:800px){.wp6-app .wp123-line-grid{grid-template-columns:1fr}.wp6-app .wp123-advanced-top{grid-template-columns:44px minmax(0,1fr)}.wp6-app .wp123-advanced-icon{width:44px;height:44px}.wp6-app .wp123-open-mwan3{grid-column:1/-1;width:100%;margin-top:4px}.wp6-app .wp123-overview-refresh{white-space:normal}.wp6-app .wp123-advanced-notice{display:block}.wp6-app .wp123-advanced-notice strong{display:block;margin-bottom:4px}}\n@media(max-width:800px){.wp6-app .wp6-header{padding:16px}.wp6-app .wp6-nav{gap:5px}.wp6-app .wp6-nav .btn{padding:8px 10px!important;font-size:12px}.wp6-app .wp6-panel>.cbi-section{padding:14px!important}.wp6-app .wp6-panel table td,.wp6-app .wp6-panel table th{padding:9px 8px}.wp6-app .wp6-brand{font-size:21px}}\n'),
            E('style',{},'/* V6.5 consolidated action guidance - presentation only */\n'+
        '.wp6-app .wp62-wizard{max-width:none!important;padding:18px!important;background:#fff!important;border:1px solid #e1e7f0!important;box-shadow:0 2px 12px #2438540b}\n'+
        '.wp6-app .wp62-wizard>p{max-width:950px}\n'+
        '.wp6-app .wp62-wizard>div{background:#f9fbff;border:1px solid #e5ebf3!important;border-radius:13px!important;padding:16px!important}\n'+
        '.wp6-app .wp62-wizard select{width:min(100%,420px)!important;max-width:100%!important}\n'+
        '.wp6-app .wp61-device-card{transition:border-color .15s,box-shadow .15s}\n'+
        '.wp6-app .wp61-device-card:focus-within{border-color:#8193f1;box-shadow:0 0 0 2px #8193f125}\n'+
        '.wp6-app .wp61-device-card .btn:disabled{opacity:.42!important}\n'+
        '.wp6-app [data-wp-tab=global] input[type=range]{width:min(100%,850px)!important;max-width:100%!important}\n'+
        '.wp6-app [data-wp-tab=global] .cbi-section{max-width:none!important}\n'+
        '.wp6-app [data-wp-tab=safety] details>summary:focus:not(:focus-visible){outline:none;box-shadow:none}\n'+
        '.wp6-app [data-wp-tab=safety] details>summary:focus-visible{outline:2px solid #5b70e8;outline-offset:2px}\n'+
        '.wp6-app [data-wp-tab=safety] details>summary{padding:10px 8px}\n'+
        '.wp6-app [data-wp-tab=rules] .cbi-button-negative{background:#fff5f5!important;color:#b42333!important;border-color:#fed5d5!important}\n'+
        '.wp6-app [data-wp-tab=diagnostics] pre{font-size:12px!important}\n'+
        '@media(max-width:800px){.wp6-app .wp62-wizard{padding:12px!important}.wp6-app .wp62-wizard>div{padding:12px!important}}\n'),
E('style',{},'/* V6.1 card-first UI; presentation only */\n'+
        '.wp6-app .wp61-device-tools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0 18px}\n'+
        '.wp6-app .wp122-save-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:28px;padding:22px 24px!important}\n'+
        '.wp6-app .wp122-save-card h3{margin:0 0 8px!important}\n'+
        '.wp6-app .wp122-save-card p{margin:0 0 7px!important}\n'+
        '.wp6-app .wp122-save-status{color:#475569;font-size:13px;line-height:1.55}\n'+
        '.wp6-app .wp122-save-action{display:flex;align-items:center;justify-content:flex-end}\n'+
        '.wp6-app .wp122-save-action .btn{min-width:132px;min-height:42px}\n'+
        '.wp6-app .wp61-device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}\n'+
        '.wp6-app .wp61-device-card{border:1px solid #e2e8f0;border-radius:14px;background:#fff;overflow:hidden}\n'+
        '.wp6-app .wp61-device-card[open]{border-color:#aab8ed;box-shadow:0 3px 15px #24356010}\n'+
        '.wp6-app .wp61-device-summary{display:flex;align-items:center;gap:12px;padding:17px!important;list-style:none;cursor:pointer}\n'+
        '.wp6-app .wp61-device-summary::-webkit-details-marker{display:none}\n'+
        '.wp6-app .wp61-device-icon{font-size:24px;color:#64748b;width:30px;text-align:center}\n'+
        '.wp6-app .wp61-device-name{display:flex;flex-direction:column;flex:1;min-width:0}\n'+
        '.wp6-app .wp61-device-name strong{font-size:15px;color:#1e293b;overflow:hidden;text-overflow:ellipsis}\n'+
        '.wp6-app .wp61-device-name small{font-size:12px;color:#64748b;margin-top:3px}\n'+
        '.wp6-app .wp61-route{color:#334155;font-weight:600;font-size:12px;max-width:145px;text-align:right}\n'+
        '.wp6-app .wp61-status{padding:4px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:11px;white-space:nowrap}\n'+
        '.wp6-app .wp61-status.is-configured{color:#166534;background:#dcfce7}\n'+
        '.wp6-app .wp61-device-inner{border-top:1px solid #edf0f6;padding:14px 17px;display:grid;gap:10px}\n'+
        '.wp6-app .wp61-device-edit{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n'+
        '.wp6-app .wp61-device-edit select{width:min(100%,260px)!important}\n'+
        '.wp6-app .wp61-muted{font-size:12px;color:#64748b}\n'+
        '.wp6-app .wp61-help{margin-top:16px;padding:10px 14px;border:1px solid #e2e8f0}\n'+
        '.wp6-app [data-wp-tab=balanced] input[type=range]{max-width:100%!important;width:100%!important;accent-color:#586de5}\n'+
        '.wp6-app [data-wp-tab=safety] .wp6-heading{margin-bottom:8px}\n'+
        '@media(max-width:900px){.wp6-app .wp61-device-grid{grid-template-columns:1fr}.wp6-app .wp122-save-card{grid-template-columns:1fr;gap:14px}.wp6-app .wp122-save-action{justify-content:flex-start}}\n'+
        '@media(max-width:480px){.wp6-app .wp61-device-summary{flex-wrap:wrap}.wp6-app .wp61-route{max-width:none;text-align:left}.wp6-app .wp61-status{margin-left:auto}}'),
      E('div',{'class':'wp6-header'},[
        E('div',{},[E('div',{'class':'wp6-brand'},'WanPilot'),E('div',{'class':'wp6-subtitle'},'双 WAN 管理 · 1.2.2')]),
        E('span',{'class':'wp6-safe-tag'},'网络设置受保护')
      ]),
      nav,pageHeading,
      E('div',{},panels)
    ]);
    switchTab('overview');
    // Refresh once when LuCI has actually attached this view; avoid a lost initial read.
    var initialRefreshDone=false;
    function refreshOnFirstMount(){
      if(initialRefreshDone || !root.isConnected)return;
      initialRefreshDone=true;
      [poll,refreshSafety,refreshGlobalState,refreshUnifiedState,refreshPublishSummary,wp71Refresh,wp72UpdateGate].forEach(function(fn){
        Promise.resolve().then(function(){return fn();}).catch(function(){});
      });
    }
    window.setTimeout(refreshOnFirstMount,250);
    var viewWasMounted=false;
    var refreshInFlight=false;
    var interval=window.setInterval(function(){
      if (root.isConnected) viewWasMounted=true;
      if (!root.isConnected) {
        if (viewWasMounted) { window.clearInterval(interval); window.clearInterval(ticker); }
        return;
      }
      // Network monitoring does not depend on the application-status widget.
      refreshOnFirstMount();
      // Do not queue a second batch while the previous refresh is pending.
      if(refreshInFlight)return;
      refreshInFlight=true;
      var tasks=[];
      [poll,refreshSafety,refreshGlobalState,refreshUnifiedState,refreshReleaseBanner,wp71Refresh].forEach(function(fn){
        try { tasks.push(Promise.resolve(fn())); }
        catch(e) { tasks.push(Promise.reject(e)); }
      });
      var rel=root.querySelector('[data-wp-tab="devices"]');
      if(rel&&rel.style.display!=='none'){
        try { tasks.push(Promise.resolve(refreshPublishSummary())); }
        catch(e) { tasks.push(Promise.reject(e)); }
      }
      Promise.allSettled(tasks).then(function(){refreshInFlight=false;},function(){refreshInFlight=false;});
    },5000);
    var ticker=window.setInterval(function(){
      if(root.isConnected)viewWasMounted=true;
      if(!root.isConnected){if(viewWasMounted){window.clearInterval(ticker);window.clearInterval(interval);}return;}
      if(!root.querySelector('#wp-v15-countdown'))return; // Retry after transient re-render.
      drawCountdown();drawGlobalCountdown();
    },1000);
    return root;
  });
 },
 handleSave: null,
 handleSaveApply: null,
 handleReset: null
});