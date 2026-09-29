const { randomUUID } = require('node:crypto');

function createConfirmation(onChange) {
  let pending = null;
  let settle = null;
  return {
    get current() { return pending; },
    request(kind, details = {}) {
      if (pending) return Promise.resolve({ action: 'cancel', remember: false });
      return new Promise(resolve => {
        settle = resolve;
        pending = { ...details, id: randomUUID(), kind };
        onChange();
      });
    },
    respond(value) {
      const allowed = pending?.kind === 'close' ? ['tray', 'quit', 'cancel'] : ['stop', 'cancel'];
      if (!pending || value?.id !== pending.id || !allowed.includes(value.action))
        throw new Error('此确认请求已失效，请重新操作');
      const result = { action: value.action, remember: pending.kind === 'close' && value.remember === true && value.action !== 'cancel' };
      const resolve = settle;
      pending = null; settle = null;
      resolve(result);
      onChange();
    },
    cancel() {
      if (pending) this.respond({ id: pending.id, action: 'cancel' });
    },
  };
}
module.exports = { createConfirmation };
