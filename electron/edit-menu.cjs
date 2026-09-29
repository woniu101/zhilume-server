const { Menu } = require('electron');

// Native editing commands use Chromium's focused field and undo history.
// No renderer IPC or background clipboard access is needed.
function installEditMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    const item = (label, role, allowed) => ({ label, role, enabled: !!allowed });
    const template = params.isEditable ? [
      item('撤销', 'undo', flags.canUndo),
      item('重做', 'redo', flags.canRedo),
      { type: 'separator' },
      item('剪切', 'cut', flags.canCut),
      item('复制', 'copy', flags.canCopy),
      item('粘贴', 'paste', flags.canPaste),
      item('粘贴为纯文本', 'pasteAndMatchStyle', flags.canPaste),
      { type: 'separator' },
      item('全选', 'selectAll', flags.canSelectAll),
    ] : [item('复制', 'copy', flags.canCopy), item('全选', 'selectAll', flags.canSelectAll)];
    Menu.buildFromTemplate(template).popup({ window });
  });
}
module.exports = { installEditMenu };
