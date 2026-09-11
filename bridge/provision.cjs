/** Executed in the isolated ChatGPT settings page. No cookies, tokens or free-form JS are accepted. */
function settingsStep(options, action = 'inspect') {
  if (location.origin !== 'https://chatgpt.com' || location.pathname !== '/' || !/^#settings\/(Plugins|Apps)/i.test(location.hash)) return { code: 'settings_page_required' };
  const visible = n => !!n && n.isConnected && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0 && getComputedStyle(n).visibility !== 'hidden';
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const label = n => {
    const linked = (n.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const text = [...(n.labels || [])].map(l => { const copy = l.cloneNode(true); copy.querySelectorAll('input,textarea,select,button').forEach(c => c.remove()); return copy.textContent; }).join(' ');
    return norm(n.getAttribute('aria-label') || linked || text || n.getAttribute('placeholder') || n.textContent);
  };
  const unique = nodes => { const found = [...nodes].filter(visible); return found.length === 1 ? found[0] : null; };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const buttons = (pattern, root = document) => all('button,[role=button]', root).filter(n => pattern.test(label(n)) && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
  const fields = all('input,textarea');
  const name = unique(fields.filter(n => /^(Name|App name|Connector name|名称|应用名称|连接器名称)$/i.test(label(n))));
  const changed = code => ({ code, changed: true });
  const click = (node, code) => { node.click(); return changed(code); };
  const set = (n, value) => {
    const proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : n.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    setter.call(n, value); n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true;
  };
  if (!name) {
    const existing = unique(all('button,a,[role=button]').filter(n => label(n) === options.name));
    if (existing) return { code: 'connector_exists_review' }; // Do not assume a same-name app has our server identity.
    const developer = unique(all('[role=switch],input[type=checkbox]').filter(n => /^(Developer mode|开发者模式)$/i.test(label(n))));
    if (developer && (developer.checked === false || developer.getAttribute('aria-checked') === 'false')) {
      return action === 'advance' ? click(developer, 'developer_mode_requested') : { code: 'developer_mode_required' };
    }
    const create = unique(buttons(/^(Create|Create app|Create connector|创建|创建应用|创建连接器)$/i));
    if (create) return action === 'advance' ? click(create, 'creation_form_opened') : { code: 'creation_form_available' };
    const advanced = unique(buttons(/^(Advanced settings|高级设置)$/i));
    if (advanced) return action === 'advance' ? click(advanced, 'advanced_settings_opened') : { code: 'developer_mode_required' };
    return { code: 'settings_action_required' };
  }
  const root = name.closest('[role=dialog],form');
  if (!root) return { code: 'creation_form_review_required' };
  if (name.value !== options.name) {
    if (action === 'advance' && set(name, options.name)) return changed('connector_name_filled');
    return { code: 'connector_name_required' };
  }
  const tunnel = unique(all('select,[role=combobox]', root).filter(n => /^(Tunnel|Select tunnel|隧道|选择隧道)$/i.test(label(n))));
  const tunnelValue = tunnel && (tunnel.value || tunnel.getAttribute('data-value') || tunnel.getAttribute('data-selected-id'));
  if (tunnelValue !== options.tunnelId) {
    if (action === 'advance' && tunnel?.tagName === 'SELECT' && [...tunnel.options].some(o => o.value === options.tunnelId) && set(tunnel, options.tunnelId)) return changed('tunnel_selected');
    const transport = unique(all('[role=radio],input[type=radio]', root).filter(n => label(n) === 'Tunnel'));
    if (action === 'advance' && transport && transport.checked !== true && transport.getAttribute('aria-checked') !== 'true') return click(transport, 'tunnel_transport_selected');
    return { code: 'tunnel_selection_required' }; // Never select an arbitrary name-only tunnel.
  }
  const authentication = unique(all('select', root).filter(n => /^(Authentication|Authentication type|认证|身份验证|身份验证方式)$/i.test(label(n))));
  if (!authentication) return { code: 'authentication_selection_required' };
  const none = [...authentication.options].find(o => /^(None|No authentication|无|无身份验证)$/i.test(norm(o.textContent)));
  if (!none || authentication.value !== none.value) {
    if (action === 'advance' && none && set(authentication, none.value)) return changed('authentication_selected');
    return { code: 'authentication_selection_required' };
  }
  const text = norm(root.textContent);
  const scanned = text.includes('codex_tool_inventory') && text.includes('codex_tool_call');
  if (!scanned) {
    const scan = unique(buttons(/^(Scan tools|扫描工具)$/i, root));
    if (scan && action === 'advance') return click(scan, 'tools_scan_requested');
    return { code: 'tools_scan_required' };
  }
  const submit = unique(buttons(/^(Create|Create app|Create connector|创建|创建应用|创建连接器)$/i, root));
  if (!submit) return { code: 'security_confirmation_required' };
  if (action === 'create') return click(submit, 'creation_submitted');
  return { code: 'ready_to_create' };
}

/** A retry after an ambiguous Create must reconcile, not blindly click Create again. */
class Provisioner {
  constructor({ evaluate, load, save, pause = ms => new Promise(r => setTimeout(r, ms)) }) { Object.assign(this, { evaluate, load, save, pause }); this.busy = false; }
  async assist(target, signal) {
    if (this.busy) return { code: 'setup_busy' };
    if (target.name !== 'Codex Native2 DEV' || !/^tunnel_[a-f0-9]{32}$/.test(target.tunnelId || '')) return { code: 'invalid_connector_target' };
    this.busy = true;
    try {
      const prior = this.load();
      if (prior?.attempted && (prior.tunnelId !== target.tunnelId || prior.name !== target.name)) return { code: 'creation_needs_reconciliation' };
      for (let step = 0; step < 10; step++) {
        if (signal?.aborted) return { code: 'operation_cancelled' };
        const snapshot = await this.evaluate(target, 'inspect');
        if (signal?.aborted) return { code: 'operation_cancelled' };
        if (snapshot.code === 'connector_exists_review') return snapshot;
        if (prior?.attempted) return { code: 'creation_needs_reconciliation' };
        if (snapshot.code === 'ready_to_create') {
          this.save({ version: 1, name: target.name, tunnelId: target.tunnelId, attempted: true, attemptedAt: new Date().toISOString() });
          const result = await this.evaluate(target, 'create');
          return result.code === 'creation_submitted' ? { code: 'creation_submitted_verify_required' } : { code: 'creation_needs_reconciliation' };
        }
        const result = await this.evaluate(target, 'advance');
        if (!result.changed) return result;
        if (result.code === 'tools_scan_requested') return { code: 'tools_scan_pending' };
        await this.pause(500);
      }
      return { code: 'settings_action_required' };
    } finally { this.busy = false; }
  }
}
module.exports = { settingsStep, Provisioner };
