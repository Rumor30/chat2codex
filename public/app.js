let key = ''; const $ = id => document.getElementById(id);
const say = value => { $('message').textContent = value; };
async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error?.message || data.error?.code || '请求失败'); return data;
}
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
function action(text, fn) { const b = el('button', text, 'secondary'); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await fn(); await refresh(); } catch (e) { say(e.message); } finally { b.disabled = false; } }; return b; }
async function refresh() {
  const { accounts, threads } = await api('/api/accounts'); $('accounts').replaceChildren(); $('threads').replaceChildren();
  for (const a of accounts) {
    const card = el('article', '', 'card'); card.append(el('h3', a.label), el('span', a.ready ? 'Ready · MCP 已验证' : a.state, `badge ${a.ready ? 'ready' : ''}`), el('p', `${a.threads} / ${a.maxThreads} 个任务槽 · ${a.enabled ? '启用' : '已停用'}`));
    card.append(el('code', `node src/cli.mjs account launch ${a.id}`));
    const controls = el('div', '', 'actions');
    controls.append(action('打开登录窗口', () => api(`/api/accounts/${a.id}/launch`, 'POST')), action('启动桥接', () => api(`/api/accounts/${a.id}/start`, 'POST')), action(a.enabled ? '停用' : '启用', () => api(`/api/accounts/${a.id}/${a.enabled ? 'disable' : 'enable'}`, 'POST')));
    controls.append(action('清理空闲会话', async () => { if (confirm('清理此账号的保留网页会话？完成后需要重新运行 MCP 探针。')) await api(`/api/accounts/${a.id}/reset`, 'POST', { confirm: true }); }));
    card.append(controls);
    if (a.models.length && !a.ready) {
      const select = el('select'); for (const m of a.models) { const option = el('option', m.display_name || m.id); option.value = m.id; select.append(option); }
      card.append(select, action('运行真实 MCP 探针', async () => { say('正在通过网页 Connector 验证工具调用和回执。请查看该账号的独立窗口。'); await api(`/api/accounts/${a.id}/verify`, 'POST', { model: select.value }); say('MCP 探针通过。'); }));
    }
    $('accounts').append(card);
  }
  if (!accounts.length) $('accounts').append(el('p', '还没有账号。添加后使用卡片中的命令打开独立登录窗口。', 'empty'));
  for (const t of threads) {
    const row = el('div', '', 'thread'); row.append(el('strong', t.id), el('p', `${t.model} · ${t.state} · ${t.pending} 个待返回工具结果`));
    if (['in_flight', 'waiting_tools', 'uncertain', 'failed'].includes(t.state)) row.append(action('取消任务', () => api('/api/cancel', 'POST', { thread_id: t.id })));
    $('threads').append(row);
  }
  if (!threads.length) $('threads').append(el('p', '暂无任务绑定。', 'empty'));
}
$('auth').onsubmit = async event => { event.preventDefault(); key = $('key').value.trim(); try { await refresh(); $('key').value = ''; $('login').hidden = true; $('workspace').hidden = false; say('已连接本地账号池。'); } catch (e) { key = ''; say(e.message); } };
$('refresh').onclick = () => refresh().catch(e => say(e.message));
$('add').onsubmit = async event => { event.preventDefault(); try { await api('/api/accounts', 'POST', { label: $('label').value }); $('label').value = ''; await refresh(); } catch (e) { say(e.message); } };
