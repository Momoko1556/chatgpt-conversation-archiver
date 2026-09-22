const buttons = [...document.querySelectorAll("button[data-export]")];
const status = document.querySelector("#status");

for (const button of buttons) button.addEventListener("click", async () => {
  const exportType = button.dataset.export;
  for (const item of buttons) item.disabled = true;
  const labels = { json: "JSON", markdown: "Markdown", txt: "TXT", images: "图片" };
  status.textContent = `正在读取完整分页并导出 ${labels[exportType]}，请不要关闭此弹窗……`;

  let progressTimer = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
      throw new Error("请先打开 chatgpt.com 中要备份的聊天窗口。");
    }
    const jobId = crypto.randomUUID();
    const execution = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: archiveCurrentConversation,
      args: [exportType, jobId]
    });
    progressTimer = setInterval(async () => {
      try {
        const progressResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: (expectedJobId) => {
            try {
              const value = JSON.parse(document.documentElement.dataset.chatgptArchiverProgress || "null");
              return value?.jobId === expectedJobId ? value : null;
            } catch { return null; }
          },
          args: [jobId]
        });
        const progress = progressResult?.[0]?.result;
        if (progress?.text) status.textContent = progress.text;
      } catch {
        // The main execution reports the authoritative error. Poll failures are transient.
      }
    }, 600);

    const injection = await execution;
    const result = injection?.[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "归档失败");

    const s = result.stats;
    const summary = [
      `${labels[exportType]} 导出完成`,
      `分页：${s.pages}`,
      `输入消息：${s.inputMessages}`,
      `唯一消息：${s.uniqueMessages}`,
      `重复消息：${s.duplicates}`
    ];
    if (exportType === "markdown" || exportType === "txt") {
      summary.push(`可读对话：${s.readable}（用户 ${s.user} / 助手 ${s.assistant}）`);
    }
    if (exportType === "images") {
      summary.push(`图片：${s.imagesDownloaded}/${s.imagesFound} 成功`);
      if (s.imagesFailed) summary.push(`图片失败：${s.imagesFailed}`);
    }
    summary.push("", ...result.files);
    status.textContent = summary.join("\n");
  } catch (error) {
    status.textContent = `归档失败：${error.message}`;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    for (const item of buttons) item.disabled = false;
  }
});
