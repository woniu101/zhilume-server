const $ = (id) => document.getElementById(id);
let activeConfirmation = null;
let confirmationBusy = false;
function render(state) {
  $("status").textContent = state.running
    ? state.ready
      ? "服务已就绪"
      : "服务启动中"
    : "服务未启动";
  $("dot").className = state.running ? "online" : "";
  $("start").disabled = state.running;
  $("stop").disabled = !state.running;
  $("open").disabled = !state.ready;
  $("browser").disabled = !state.ready;
  $("address").textContent = state.address;
  $("port").value = state.port;
  $("close-behavior").value = state.closeBehavior;
  $("data-path").value = state.dataDirectory;
  for (const id of ["port", "directory-picker", "configure"])
    $(id).disabled = state.running;
  $("copy").disabled = !state.ready;
  $("directory").textContent = state.dataDirectory;
  $("logs").textContent = state.logs.join("\n") || "等待服务启动…";
  $("logs").scrollTop = $("logs").scrollHeight;
  renderConfirmation(state.confirmation);
}
for (const action of ["start", "stop", "open", "copy", "browser"])
  $(action).onclick = async () => {
    try {
      const result = await window.launcher[action]();
      if (action === "start" || action === "stop") render(result);
      $("message").textContent =
        action === "copy"
          ? "访问凭证已复制，请在 Studio 或管理台中粘贴。"
          : action === "open"
            ? "已打开独立的 Zhilume Server 管理台。"
            : "连接 Studio 或外部浏览器时，复制访问凭证使用。";
    } catch (e) {
      $("message").textContent = e.message;
    }
  };
document.body.classList.toggle(
  "light",
  localStorage.getItem("theme") === "light",
);
$("theme").onclick = () => {
  document.body.classList.toggle("light");
  localStorage.setItem(
    "theme",
    document.body.classList.contains("light") ? "light" : "dark",
  );
};
window.launcher.subscribe(render);
window.launcher.state().then(render);

$("directory-picker").onclick = async () => {
  try {
    const value = await window.launcher.directory();
    if (value) $("data-path").value = value;
  } catch (e) {
    $("message").textContent = e.message;
  }
};
$("configure").onclick = async () => {
  try {
    render(
      await window.launcher.configure({
        port: Number($("port").value),
        dataDirectory: $("data-path").value,
      }),
    );
    $("message").textContent = "配置已保存";
  } catch (e) {
    $("message").textContent = e.message;
  }
};

$("close-behavior").onchange = async () => {
  try {
    render(await window.launcher.closeBehavior($("close-behavior").value));
    $("message").textContent = "关闭行为已保存";
  } catch (e) { $("message").textContent = e.message; }
};

function selectedCloseAction() {
  return document.querySelector('input[name="close-action"]:checked').value;
}
function updateConfirmButton() {
  $("confirm-submit").textContent = activeConfirmation?.kind === "stop" ? "停止服务"
    : selectedCloseAction() === "tray" ? "收起到托盘"
    : activeConfirmation?.running ? "停止并退出" : "退出启动器";
}
function renderConfirmation(value) {
  const modal = $("confirmation");
  if (!value) {
    activeConfirmation = null;
    if (modal.open) modal.close();
    return;
  }
  if (activeConfirmation?.id === value.id) return;
  activeConfirmation = value;
  confirmationBusy = false;
  const isClose = value.kind === "close";
  $("confirm-title").textContent = isClose ? "关闭启动器" : "停止正在运行的服务？";
  $("confirm-description").textContent = isClose
    ? value.running ? "Server 正在运行，选择关闭后的处理方式。" : "Server 尚未启动，你可以收起窗口或直接退出。"
    : `当前有 ${value.taskCount} 个任务正在执行。停止服务会断开 Studio 与执行端连接，任务可能中断。`;
  $("close-options").hidden = !isClose;
  $("remember-option").hidden = !isClose;
  $("tray-description").textContent = value.running ? "保持服务运行，稍后从托盘重新打开。" : "保留启动器，稍后从托盘重新打开。";
  $("quit-label").textContent = value.running ? "停止服务并退出" : "退出启动器";
  $("quit-description").textContent = value.running ? "断开 Studio 与管理台连接。项目数据会保留。" : "关闭应用，不影响已保存的项目与素材。";
  document.querySelector('input[name="close-action"][value="tray"]').checked = true;
  $("confirm-remember").checked = false;
  $("confirm-error").hidden = true;
  for (const button of modal.querySelectorAll('button')) button.disabled = false;
  $("confirm-cancel").textContent = isClose ? "取消" : "继续运行";
  updateConfirmButton();
  if (!modal.open) modal.showModal();
  $("confirm-cancel").focus();
}
async function finishConfirmation(action) {
  if (!activeConfirmation || confirmationBusy) return;
  confirmationBusy = true;
  const requestId = activeConfirmation.id;
  for (const button of $("confirmation").querySelectorAll('button')) button.disabled = true;
  try {
    await window.launcher.confirm({ id: requestId, action, remember: $("confirm-remember").checked });
  } catch (error) {
    if (activeConfirmation?.id === requestId) {
      $("confirm-error").textContent = error.message;
      $("confirm-error").hidden = false;
      for (const button of $("confirmation").querySelectorAll('button')) button.disabled = false;
    }
  } finally { confirmationBusy = false; }
}
$("confirm-form").onsubmit = event => {
  event.preventDefault();
  void finishConfirmation(activeConfirmation?.kind === "stop" ? "stop" : selectedCloseAction());
};
$("confirm-cancel").onclick = $("confirm-dismiss").onclick = () => void finishConfirmation("cancel");
$("confirmation").addEventListener("cancel", event => { event.preventDefault(); void finishConfirmation("cancel"); });
for (const input of document.querySelectorAll('input[name="close-action"]')) input.onchange = updateConfirmButton;
