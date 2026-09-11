let key = ''; let setupId = ''; let refreshing = false; let timer; let messageTimer; let snapshot = '';
const $ = id => document.getElementById(id);
const labels = {
  ready: '已验证，可接入', needs_mcp_probe: '等待 MCP 模型验证', probe_running: '正在验证 MCP', worker_offline: '桥接尚未启动',
  setup_required: '尚未配置 Tunnel', tunnel_unavailable: 'Tunnel 未连接', launcher_unavailable: '请打开账号登录窗口',
  launcher_login_required: '请先登录账号', launcher_upgrade_required: '请重启升级后的登录窗口', launcher_identity_mismatch: '账号身份不匹配',
  runtime_restart_required: '配置已更改，请重启桥接', dependency_missing: '缺少运行依赖，请检查运行环境', network_unavailable: '网络连接不可用',
  model_verified: '所选模型已通过真实 MCP 验证', model_not_verified: '所选模型还未验证', completed: '配置完成',
  tunnel_configured_connector_required: 'Tunnel 已配置；下一步运行设置助手并验证模型',
  creation_form_review_required: '无法确定创建表单，请在账号窗口核对', journal_write_failed: '状态写入失败，请检查磁盘空间',
  operation_timeout: '配置操作超时，请检查网络后核对状态', stop_external_worker_required: '请先停止手动启动的桥接进程',
  settings_opened: '设置页已打开', connector_exists_review: '已有同名连接器，请核对它的 Tunnel 后运行验证',
  creation_submitted_verify_required: '已提交创建，请完成权限确认并运行 MCP 验证',
  creation_needs_reconciliation: '上次创建结果不确定，请在设置页核对；不会重复创建',
  settings_action_required: '页面未匹配，请在账号窗口完成当前步骤', settings_page_required: '请在账号窗口打开 Apps 设置',
  developer_mode_required: '需要开发者模式或管理员授权', tunnel_selection_required: '请手动选择正确的 Tunnel',
  authentication_selection_required: '请核对 Tunnel 的认证方式', security_confirmation_required: '请在账号窗口完成安全确认',
  tools_scan_required: '请扫描 Connector 工具', tools_scan_pending: '工具扫描已发起，完成后可继续设置助手',
  settings_bridge_failed: '设置助手未完成，请查看账号窗口', setup_consent_required: '需要你的配置授权',
  account_busy: '账号仍有活动任务或配置操作', retire_threads_first: '请先释放该账号的旧线程',
  worker_restarted_probe_required: '桥接已重启，需要重新验证模型', account_archived_profiles_retained: '账号已归档，本地登录资料保留',
  invitation_expired: '自动连接凭证已过期，请使用 token 命令获取本地密钥', operation_cancelled: '操作已取消',
  process_restarted: '进程重启中断了操作，请核对状态后继续', operation_failed: '操作未完成，请查看账号窗口和运行环境',
};
const text = code => labels[code] || code;
const say = message => { $('message').textContent = message; clearTimeout(messageTimer); messageTimer = setTimeout(() => { $('message').textContent = ''; }, 8000); };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw new Error(text(data.error?.code) || data.error?.message || '请求失败');
  return data;
}
const el = (tag, value = '', cls = '') => { const node = document.createElement(tag); node.textContent = value; if (cls) node.className = cls; return node; };
function action(title, fn, disabled = false) {
  const button = el('button', title, 'secondary'); button.type = 'button'; button.disabled = disabled;
  button.onclick = async () => { button.disabled = true; try { await fn(); snapshot = ''; await refresh(); } catch (e) { say(e.message); } finally { button.disabled = disabled; } };
  return button;
}
async function operation(id, body) {
  await api(`/api/accounts/${id}/actions`, 'POST', body); say('操作已开始，进度显示在“配置进度”中。');
}
function renderAccounts(accounts) {
  $('accounts').replaceChildren(); $('count').textContent = `${accounts.filter(a => !a.archived).length} 个账号`;
  for (const account of accounts.filter(a => !a.archived)) {
    const card = el('article', '', 'card'); const heading = el('div', '', 'toolbar'); heading.append(el('h3', account.label), el('span', account.enabled ? '启用' : '停用', 'badge'));
    card.append(heading, el('span', account.operation ? '配置操作进行中' : text(account.state), `badge ${account.ready ? 'ready' : ''}`), el('p', `${account.threads} / ${account.maxThreads} 个保留任务槽`));
    const flow = el('ol', '', 'steps'); for (const step of ['登录独立账号', '连接 Tunnel', '准备 Connector', '验证所选模型']) flow.append(el('li', step)); card.append(flow);
    const controls = el('div', '', 'actions');
    controls.append(action('① 登录窗口', () => api(`/api/accounts/${account.id}/launch`, 'POST'), account.operation),
      action('② 配置 Tunnel', () => { setupId = account.id; $('setup-account').textContent = account.label; $('configure').reset(); $('setup').showModal(); }, account.operation),
      action('③ 设置助手', async () => { if (confirm('允许设置助手在此账号的 Apps 设置中填写并创建指定 Tunnel 的 Connector？安全确认与额外授权仍由你完成。')) await operation(account.id, { action: 'assist', consent: true }); }, account.operation),
      action('手动打开设置', () => operation(account.id, { action: 'open-settings' }), account.operation));
    card.append(controls);
    const available = account.availableModels || account.models;
    if (available.length) {
      const select = el('select'); select.setAttribute('aria-label', `${account.label} 的模型`);
      for (const model of available) { const verified = account.models.some(m => m.id === model.id); const option = el('option', `${model.display_name || model.id}${verified ? ' · 已验证' : ''}`); option.value = model.id; select.append(option); }
      const line = el('div', '', 'actions'); line.append(select, action('④ 验证该模型', () => operation(account.id, { action: 'verify', model: select.value }), account.operation)); card.append(line);
    }
    card.append(el('p', account.models.length ? `已验证：${account.models.map(m => m.id).join('、')}` : '尚无模型通过验证。', 'muted'));
    const more = el('details'); more.append(el('summary', '运行与账号管理'));
    const admin = el('div', '', 'actions'); admin.append(action('启动桥接', () => api(`/api/accounts/${account.id}/start`, 'POST'), account.operation),
      action('重启桥接', () => operation(account.id, { action: 'restart' }), account.operation),
      action(account.enabled ? '停止接收新任务' : '启用账号', () => api(`/api/accounts/${account.id}/${account.enabled ? 'disable' : 'enable'}`, 'POST'), account.operation),
      action('任务槽位', async () => { const value = prompt('每账号保留任务槽位（1—5）。保持当前工具轮次的账号绑定。', account.maxThreads); if (value !== null && value.trim()) await api(`/api/accounts/${account.id}/settings`, 'POST', { maxThreads: Number(value) }); }, account.operation),
      action('重命名', async () => { const label = prompt('新的账号名称', account.label); if (label?.trim()) await api(`/api/accounts/${account.id}/settings`, 'POST', { label }); }, account.operation),
      action('归档账号', async () => { if (confirm('停止使用并隐藏此账号？本地登录资料不会删除，可用同一账号 ID 恢复。')) await operation(account.id, { action: 'archive' }); }, account.operation));
    more.append(admin, el('code', account.id)); card.append(more); $('accounts').append(card);
  }
  if (!accounts.some(a => !a.archived)) $('accounts').append(el('p', '添加账号后，按 ①—④ 完成首次设置。', 'empty'));
  for (const account of accounts.filter(a => a.archived)) $('accounts').append(action(`恢复归档：${account.label}`, () => api(`/api/accounts/${account.id}/settings`, 'POST', { archived: false })));
}
function renderThreads(threads) {
  $('threads').replaceChildren();
  for (const thread of threads) {
    const row = el('div', '', 'thread'); row.append(el('code', thread.id), el('p', `${thread.model} · ${thread.state} · ${thread.pending} 个待返回结果`));
    if (['in_flight', 'waiting_tools', 'uncertain', 'failed'].includes(thread.state)) row.append(action('取消任务', () => api('/api/cancel', 'POST', { thread_id: thread.id })));
    if (!thread.pending && thread.state !== 'in_flight') row.append(action('释放此线程', () => api('/api/threads/retire', 'POST', { thread_id: thread.id })));
    $('threads').append(row);
  }
  if (!threads.length) $('threads').append(el('p', '暂无保留线程。', 'empty'));
}
function renderJobs(jobs, accounts) {
  $('jobs').replaceChildren();
  for (const job of jobs.slice(0, 8)) {
    const row = el('div', '', 'job'); row.append(el('strong', accounts.find(a => a.id === job.accountId)?.label || '账号'),
      el('span', `${job.kind} · ${text(job.code || job.step)}`, 'muted'), el('span', ({ running: '进行中', succeeded: '已完成', waiting_user: '需要操作', failed: '未完成', cancelled: '已取消', interrupted: '已中断' })[job.state], `badge ${job.state === 'succeeded' ? 'ready' : ''}`));
    if (job.state === 'running') row.append(action('取消', () => api(`/api/jobs/${job.id}/cancel`, 'POST')));
    $('jobs').append(row);
  }
  if (!jobs.length) $('jobs').append(el('p', '配置操作将在这里显示。不记录 Cookie、密钥或对话。', 'empty'));
}
async function refresh() {
  if (!key || refreshing) return; refreshing = true;
  try {
    const [data, progress] = await Promise.all([api('/api/accounts'), api('/api/jobs')]);
    const next = JSON.stringify(data);
    if (next !== snapshot) { renderAccounts(data.accounts); renderThreads(data.threads); snapshot = next; }
    renderJobs(progress.jobs, data.accounts);
  } finally { refreshing = false; }
}
async function system() {
  const result = await api('/api/system'); $('checks').replaceChildren();
  for (const check of result.checks) $('checks').append(el('span', `${check.ok ? '✓' : '○'} ${check.name}${check.version ? ` ${check.version}` : ''}${check.tested === false ? ' · 未验证版本' : ''}`, `badge ${check.ok ? 'ready' : ''}`));
}
async function unlock(value) {
  key = value; await refresh(); $('key').value = ''; $('login').hidden = true; $('workspace').hidden = false;
  $('endpoint').textContent = `${location.origin}/v1`; clearInterval(timer); timer = setInterval(() => refresh().catch(e => say(e.message)), 4000);
  await system().catch(() => say('运行环境检查暂不可用，可点击重新检查。')); say('已连接本地控制台。');
}
$('auth').onsubmit = async event => { event.preventDefault(); try { await unlock($('key').value.trim()); } catch (e) { key = ''; say(e.message); } };
$('refresh').onclick = () => refresh().catch(e => say(e.message)); $('diagnose').onclick = () => system().catch(e => say(e.message));
$('logout').onclick = () => { key = ''; clearInterval(timer); $('workspace').hidden = true; $('login').hidden = false; $('accounts').replaceChildren(); snapshot = ''; say('控制台已锁定，进行中的 Codex 任务不受影响。'); };
$('add').onsubmit = async event => { event.preventDefault(); try { await api('/api/accounts', 'POST', { label: $('label').value }); $('label').value = ''; await refresh(); } catch (e) { say(e.message); } };
$('close-setup').onclick = () => { $('configure').reset(); $('setup').close(); };
$('setup').addEventListener('cancel', () => $('configure').reset());
$('configure').onsubmit = async event => { event.preventDefault(); const credentials = { action: 'configure', tunnelId: $('tunnel-id').value.trim(), runtimeKey: $('runtime-key').value, consent: $('consent').checked };
  $('runtime-key').value = ''; $('setup').close();
  try { await operation(setupId, credentials); await refresh(); } catch (e) { say(e.message); } finally { credentials.runtimeKey = ''; }
};
$('copy-key').onclick = () => navigator.clipboard.writeText(key).then(() => say('已复制本地 API key。'), () => say('浏览器不允许写剪贴板，请使用 token 命令。'));
$('export').onclick = async () => { try { const report = await api('/api/diagnostics'); const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const anchor = el('a'); anchor.href = url; anchor.download = 'chat2codex-diagnostics.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { say(e.message); } };
const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invite) {
  history.replaceState(null, '', location.pathname);
  api('/api/session', 'POST', { ticket: invite }).then(data => unlock(data.key)).catch(e => say(e.message));
}
