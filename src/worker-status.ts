export function workerStatus(worker: any, jobs: any[], now = Date.now()) {
  const heartbeatAgeSeconds = worker.lastHeartbeat ? Math.max(0, Math.floor((now - worker.lastHeartbeat) / 1000)) : null;
  const fresh = worker.connected && heartbeatAgeSeconds !== null && heartbeatAgeSeconds < 40;
  const activeJobs = jobs.filter(j => j.workerId === worker.id && ["assigned", "running", "cancel_requested"].includes(j.status)).map(j => ({ id: j.id, status: j.status, stage: j.stage }));
  const state = worker.disabled ? "disabled" : !fresh ? "offline" : worker.draining ? "draining" : activeJobs.length || worker.activeAttempts?.length ? "busy" : "ready";
  const reason = ({ disabled: "执行端已停用", offline: worker.lastHeartbeat ? "连接中断或心跳超时" : "已登记，等待首次连接", draining: "正在排空，不接收新任务", busy: "正在执行任务", ready: "可接收任务" })[state];
  return { state, reason: state === 'busy' && !activeJobs.length ? '正在确认资源释放' : reason, heartbeatAgeSeconds, activeJobs };
}
