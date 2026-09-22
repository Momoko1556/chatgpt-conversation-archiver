async function archiveCurrentConversation(exportType, jobId) {
  const MAX_PAGES = 500;
  const NUM_TURNS = 100;

  const setProgress = (text, phase, current = null, total = null) => {
    document.documentElement.dataset.chatgptArchiverProgress = JSON.stringify({
      jobId, text, phase, current, total, updatedAt: Date.now()
    });
  };

  try {
    setProgress("正在验证 ChatGPT 登录会话……", "session");
    const match = location.pathname.match(/\/c\/([0-9a-f-]{20,})/i);
    if (!match) throw new Error("当前页面不是可识别的 ChatGPT 对话 URL。");
    const conversationId = match[1];
    const accessToken = await getAccessToken();
    const pages = [];
    const cursorPairs = new Set();
    let before = null;

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      setProgress(`正在读取第 ${pageNumber} 页……`, "pages", pageNumber - 1, null);
      const url = new URL(`/backend-api/conversations/${conversationId}`, location.origin);
      url.searchParams.set("include_has_versions", "true");
      url.searchParams.set("num_turns", String(NUM_TURNS));
      if (before) url.searchParams.set("before", before);

      const response = await fetchWithTimeout(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`
        }
      }, 45_000, `第 ${pageNumber} 页请求超时`);

      if (!response.ok) {
        throw new Error(`第 ${pageNumber} 页请求失败：HTTP ${response.status}`);
      }

      const page = await response.json();
      validatePage(page, conversationId, pageNumber);

      const info = page.page_info;
      const pair = `${info.start_cursor || ""}\u0000${info.end_cursor || ""}`;
      if (cursorPairs.has(pair)) {
        throw new Error(`第 ${pageNumber} 页与前页重复，已停止，未生成“完整归档”。`);
      }
      cursorPairs.add(pair);

      pages.push({ pageNumber, requestedBefore: before, data: page });

      if (info.has_previous_page === false) {
        setProgress(`分页读取完成：${pageNumber}/${pageNumber} 页`, "pages", pageNumber, pageNumber);
        break;
      }
      setProgress(`已完成 ${pageNumber} 页，正在继续读取更早内容……`, "pages", pageNumber, null);
      if (!info.start_cursor) {
        throw new Error(`第 ${pageNumber} 页仍有更早内容，但缺少 start_cursor。`);
      }
      before = info.start_cursor;

      if (pageNumber === MAX_PAGES) {
        throw new Error(`达到安全上限 ${MAX_PAGES} 页，未确认最老页，已停止。`);
      }
    }

    const oldest = pages.at(-1).data;
    if (oldest.page_info.has_previous_page !== false) {
      throw new Error("没有抓到 has_previous_page=false，禁止生成“完整归档”。");
    }

    const merged = mergePages(pages);
    const safeTitle = sanitizeFilename(merged.title || "ChatGPT对话");
    const jsonName = `${safeTitle}_完整合并.json`;
    const mdName = `${safeTitle}_完整对话.md`;
    const txtName = `${safeTitle}_完整对话.txt`;
    const imageZipName = `${safeTitle}_图片.zip`;
    let readable = { markdown: "", total: 0, user: 0, assistant: 0 };
    let imageArchive = { blob: null, found: 0, downloaded: 0, failed: 0 };
    const files = [];

    if (exportType === "json") {
      setProgress(`已完成 ${pages.length}/${pages.length} 页，正在生成 JSON……`, "json", pages.length, pages.length);
      downloadText(jsonName, JSON.stringify(merged, null, 2), "application/json;charset=utf-8");
      files.push(jsonName);
    } else if (exportType === "markdown") {
      setProgress(`已完成 ${pages.length}/${pages.length} 页，正在生成 Markdown……`, "markdown", pages.length, pages.length);
      readable = buildReadableMarkdown(merged);
      downloadText(mdName, readable.markdown, "text/markdown;charset=utf-8");
      files.push(mdName);
    } else if (exportType === "txt") {
      setProgress(`已完成 ${pages.length}/${pages.length} 页，正在生成 TXT……`, "txt", pages.length, pages.length);
      readable = buildReadableMarkdown(merged);
      downloadText(txtName, markdownToPlainText(readable.markdown), "text/plain;charset=utf-8");
      files.push(txtName);
    } else if (exportType === "images") {
      setProgress(`已完成 ${pages.length}/${pages.length} 页，正在整理图片清单……`, "images", 0, null);
      imageArchive = await buildImageArchive(merged, accessToken, setProgress);
      if (!imageArchive.blob) throw new Error("这个对话中没有找到可归档的图片引用。");
      downloadBlob(imageZipName, imageArchive.blob);
      files.push(imageZipName);
    }

    setProgress(`${exportType === "images" ? "图片" : exportType === "markdown" ? "Markdown" : exportType === "txt" ? "TXT" : "JSON"} 导出完成`, "done");
    return {
      ok: true,
      files,
      stats: {
        pages: pages.length,
        inputMessages: merged._archive.input_message_count,
        uniqueMessages: merged._archive.unique_message_count,
        duplicates: merged._archive.duplicate_message_count,
        readable: readable.total,
        user: readable.user,
        assistant: readable.assistant,
        imagesFound: imageArchive.found,
        imagesDownloaded: imageArchive.downloaded,
        imagesFailed: imageArchive.failed
      }
    };
  } catch (error) {
    setProgress(`归档失败：${error?.message || String(error)}`, "error");
    return { ok: false, error: error?.message || String(error) };
  }

  async function fetchWithTimeout(input, init, timeoutMs, timeoutMessage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(timeoutMessage);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getAccessToken() {
    const response = await fetchWithTimeout("/api/auth/session", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store"
    }, 30_000, "读取 ChatGPT 登录会话超时");
    if (!response.ok) {
      throw new Error(`无法读取当前 ChatGPT 登录会话：HTTP ${response.status}。请刷新页面或重新登录。`);
    }
    const session = await response.json();
    const token = session?.accessToken || session?.access_token;
    if (typeof token !== "string" || token.length < 20) {
      throw new Error("当前 ChatGPT 会话未返回访问令牌。请刷新页面或重新登录后重试。");
    }
    return token;
  }

  function validatePage(page, expectedId, pageNumber) {
    if (!page || typeof page !== "object") throw new Error(`第 ${pageNumber} 页不是 JSON 对象。`);
    if (page.conversation_id !== expectedId) throw new Error(`第 ${pageNumber} 页 conversation_id 不一致。`);
    if (!Array.isArray(page.messages)) throw new Error(`第 ${pageNumber} 页缺少 messages 数组。`);
    if (!page.page_info || typeof page.page_info !== "object") throw new Error(`第 ${pageNumber} 页缺少 page_info。`);
    if (typeof page.page_info.has_previous_page !== "boolean") {
      throw new Error(`第 ${pageNumber} 页的 has_previous_page 无效。`);
    }
  }

  function mergePages(pageEntries) {
    const latest = pageEntries[0].data;
    const oldest = pageEntries.at(-1).data;
    const merged = structuredClone(latest);
    const seen = new Set();
    const messages = [];
    let inputCount = 0;

    for (const entry of [...pageEntries].reverse()) {
      for (const message of entry.data.messages) {
        inputCount += 1;
        const id = message?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        messages.push(message);
      }
    }

    merged.messages = messages;
    merged.current_node = latest.current_node;
    merged.page_info = {
      start_cursor: oldest.page_info.start_cursor ?? null,
      end_cursor: latest.page_info.end_cursor ?? null,
      has_previous_page: false,
      has_next_page: false
    };

    for (const key of ["safe_urls", "blocked_urls", "plugin_ids", "disabled_tool_ids", "context_scopes"]) {
      const values = [];
      const keys = new Set();
      for (const entry of pageEntries) {
        if (!Array.isArray(entry.data[key])) continue;
        for (const value of entry.data[key]) {
          const identity = typeof value === "string" ? value : JSON.stringify(value);
          if (!keys.has(identity)) { keys.add(identity); values.push(value); }
        }
      }
      if (values.length) merged[key] = values;
    }

    merged._archive = {
      format: "chatgpt-conversation-archiver/v1",
      archived_at: new Date().toISOString(),
      page_count: pageEntries.length,
      input_message_count: inputCount,
      unique_message_count: messages.length,
      duplicate_message_count: inputCount - messages.length,
      pagination: pageEntries.map((entry) => ({
        page: entry.pageNumber,
        requested_before: entry.requestedBefore,
        message_count: entry.data.messages.length,
        start_cursor: entry.data.page_info.start_cursor ?? null,
        end_cursor: entry.data.page_info.end_cursor ?? null,
        has_previous_page: entry.data.page_info.has_previous_page,
        has_next_page: entry.data.page_info.has_next_page
      }))
    };
    return merged;
  }

  function buildReadableMarkdown(conversation) {
    const lines = [];
    const counts = { user: 0, assistant: 0 };
    let imageNumber = 0;
    const readableMessages = [];

    for (const message of conversation.messages) {
      const role = message?.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      const metadata = message.metadata || {};
      if (metadata.is_visually_hidden_from_conversation === true) continue;
      if (metadata.is_thinking_preamble_message === true) continue;
      if (message.recipient != null && message.recipient !== "all") continue;

      const content = message.content || {};
      const type = content.content_type;
      if (["thoughts", "reasoning", "reasoning_recap", "model_editable_context", "code"].includes(type)) continue;
      if (!["text", "multimodal_text"].includes(type)) continue;

      const body = [];
      for (const part of Array.isArray(content.parts) ? content.parts : []) {
        if (typeof part === "string") {
          if (part.trim()) body.push(part.trim());
          continue;
        }
        if (!part || typeof part !== "object") continue;
        const partType = part.content_type || part.type || "";
        if (/image/i.test(partType) || part.asset_pointer || part.image_url) {
          imageNumber += 1;
          body.push(`[图片 ${imageNumber}]`);
        } else if (typeof part.text === "string" && part.text.trim()) {
          body.push(part.text.trim());
        }
      }
      if (!body.length) continue;

      counts[role] += 1;
      readableMessages.push({ role, time: formatShanghai(message.create_time), body: body.join("\n\n") });
    }

    lines.push(`# ${conversation.title || "ChatGPT 对话"}`);
    lines.push("");
    lines.push(`- Conversation ID: \`${conversation.conversation_id}\``);
    lines.push(`- 原始消息数: ${conversation.messages.length}`);
    lines.push(`- 可读对话数: ${readableMessages.length}（用户 ${counts.user} / 助手 ${counts.assistant}）`);
    lines.push("- 时区: Asia/Shanghai");
    lines.push("");
    lines.push("---");

    for (const item of readableMessages) {
      lines.push("");
      lines.push(`## ${item.role === "user" ? "用户" : "助手"} · ${item.time}`);
      lines.push("");
      lines.push(item.body);
    }
    lines.push("");

    return { markdown: lines.join("\n"), total: readableMessages.length, ...counts };
  }

  async function buildImageArchive(conversation, token, reportProgress) {
    const refs = [];
    const seen = new Set();

    for (const message of conversation.messages) {
      for (const part of Array.isArray(message?.content?.parts) ? message.content.parts : []) {
        if (!part || typeof part !== "object") continue;
        const pointer = typeof part.asset_pointer === "string" ? part.asset_pointer : null;
        if (!pointer?.startsWith("sediment://") || seen.has(pointer)) continue;
        seen.add(pointer);
        refs.push({
          index: refs.length + 1,
          pointer,
          fileId: pointer.slice("sediment://".length),
          messageId: message.id ?? null,
          role: message?.author?.role ?? null,
          createTime: message.create_time ?? null,
          declaredMimeType: part.mime_type ?? null,
          declaredSize: part.size_bytes ?? null,
          width: part.width ?? null,
          height: part.height ?? null
        });
      }
    }

    if (!refs.length) return { blob: null, found: 0, downloaded: 0, failed: 0 };

    const entries = [];
    const manifest = [];
    let completed = 0;
    for (const ref of refs) {
      reportProgress(`正在下载图片 ${completed + 1}/${refs.length}……`, "images", completed, refs.length);
      try {
        const file = await fetchImage(ref.fileId, conversation.conversation_id, token);
        const extension = extensionForMime(file.mimeType);
        const filename = `images/image_${String(ref.index).padStart(3, "0")}_${ref.fileId}${extension}`;
        entries.push({ name: filename, data: new Uint8Array(file.buffer) });
        manifest.push({
          ...ref,
          filename,
          mimeType: file.mimeType,
          downloadedSize: file.buffer.byteLength,
          status: "downloaded"
        });
      } catch (error) {
        manifest.push({ ...ref, status: "failed", error: error?.message || String(error) });
      }
      completed += 1;
      reportProgress(`已完成 ${completed}/${refs.length} 张图片`, "images", completed, refs.length);
    }

    entries.push({
      name: "manifest.json",
      data: new TextEncoder().encode(JSON.stringify({
        conversation_id: conversation.conversation_id,
        title: conversation.title,
        archived_at: new Date().toISOString(),
        image_count: refs.length,
        downloaded_count: manifest.filter((item) => item.status === "downloaded").length,
        failed_count: manifest.filter((item) => item.status === "failed").length,
        images: manifest
      }, null, 2))
    });

    const downloaded = manifest.filter((item) => item.status === "downloaded").length;
    reportProgress(`图片下载完成 ${completed}/${refs.length}，正在打包 ZIP……`, "zip", completed, refs.length);
    return {
      blob: createStoreZip(entries),
      found: refs.length,
      downloaded,
      failed: refs.length - downloaded
    };
  }

  async function fetchImage(fileId, conversationId, token) {
    const primaryUrl = new URL(`/backend-api/files/download/${encodeURIComponent(fileId)}`, location.origin);
    primaryUrl.searchParams.set("conversation_id", conversationId);
    primaryUrl.searchParams.set("inline", "false");

    let response = await fetchWithTimeout(primaryUrl, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "*/*", Authorization: `Bearer ${token}` },
      redirect: "follow"
    }, 45_000, `解析图片 ${fileId} 超时`);
    if (response.status === 404) {
      response = await fetchWithTimeout(`/backend-api/files/${encodeURIComponent(fileId)}/download`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "*/*", Authorization: `Bearer ${token}` },
        redirect: "follow"
      }, 45_000, `兼容接口解析图片 ${fileId} 超时`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (contentType === "application/json") {
      const payload = await response.json();
      const downloadUrl = payload.download_url || payload.url || payload.signed_url;
      if (!downloadUrl) throw new Error("下载接口未返回图片地址");
      const resolvedUrl = new URL(downloadUrl, location.origin);
      const isChatGptOrigin = resolvedUrl.origin === location.origin;
      const fileResponse = await fetchWithTimeout(resolvedUrl, {
        method: "GET",
        credentials: isChatGptOrigin ? "include" : "omit",
        headers: isChatGptOrigin ? { Authorization: `Bearer ${token}` } : {}
      }, 90_000, `下载图片 ${fileId} 超时`);
      if (!fileResponse.ok) throw new Error(`图片地址 HTTP ${fileResponse.status}`);
      return {
        buffer: await fileResponse.arrayBuffer(),
        mimeType: (fileResponse.headers.get("content-type") || "application/octet-stream").split(";")[0]
      };
    }
    return { buffer: await response.arrayBuffer(), mimeType: contentType || "application/octet-stream" };
  }

  function extensionForMime(mime) {
    const extensions = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
      "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
      "image/bmp": ".bmp", "image/tiff": ".tif"
    };
    return extensions[mime] || ".bin";
  }

  function createStoreZip(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function formatShanghai(value) {
    if (value == null) return "时间未知";
    const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  }

  function markdownToPlainText(markdown) {
    return markdown
      .replace(/^# (.+)$/gm, "$1")
      .replace(/^## (.+)$/gm, "$1")
      .replace(/^- (.+)$/gm, "$1")
      .replace(/^---$/gm, "========================================")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\n{3,}/g, "\n\n");
  }

  function sanitizeFilename(value) {
    return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || "ChatGPT对话";
  }

  function downloadText(filename, text, type) {
    downloadBlob(filename, new Blob([text], { type }));
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
