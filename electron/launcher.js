const $ = (id) => document.getElementById(id);
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
  $("data-path").value = state.dataDirectory;
  for (const id of ["port", "directory-picker", "configure"])
    $(id).disabled = state.running;
  $("copy").disabled = !state.ready;
  $("directory").textContent = state.dataDirectory;
  $("logs").textContent = state.logs.join("\n") || "等待服务启动…";
  $("logs").scrollTop = $("logs").scrollHeight;
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
            : "首次连接 Studio 或管理台时，粘贴本机访问凭证。";
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
