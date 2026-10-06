const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execSync } = require('child_process');

// 1. 載入 .env 環境變數
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        process.env[key] = val;
      }
    }
  });
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;

// 2. 本地 Markdown 檔案與 Notion Page ID 對應表
const PAGE_MAP = {
  'README.md': '3dbd9f07-d8de-8047-a199-eac4d111869e',
  '01-機票住宿.md': '3dbd9f07-d8de-81ac-af78-fc8c0147ad4d',
  '01-住宿候選清單.md': '3dbd9f07-d8de-8042-9bf9-d0b4fa66cde6',
  '02-交通租車.md': '3dbd9f07-d8de-814e-8744-e6b597fd84d7',
  '03-每日詳細行程.md': '3dbd9f07-d8de-81fa-9236-d8c2f60233d7',
  '04-行李清單.md': '3dbd9f07-d8de-8187-bcfb-d268136af7f4',
  '05-預算分攤.md': '3dbd9f07-d8de-8154-91a9-fe1a8ccab0a3',
};

// 子頁面 Notion URL 映射（處理 README 中的子頁面連結）
const CHILD_PAGE_URLS = {
  '01-機票住宿.md': 'https://app.notion.com/p/3dbd9f07d8de81acaf78fc8c0147ad4d',
  '01-住宿候選清單.md': 'https://app.notion.com/p/3dbd9f07d8de80429bf9d0b4fa66cde6',
  '02-交通租車.md': 'https://app.notion.com/p/3dbd9f07d8de814e8744e6b597fd84d7',
  '03-每日詳細行程.md': 'https://app.notion.com/p/3dbd9f07d8de81fa9236d8c2f60233d7',
  '04-行李清單.md': 'https://app.notion.com/p/3dbd9f07d8de8187bcfbd268136af7f4',
  '05-預算分攤.md': 'https://app.notion.com/p/3dbd9f07d8de815491a9fe1a8ccab0a3',
};

// 3. 解析 URL (處理相對路徑、錨點與 Notion URL 轉換)
function resolveUrl(rawUrl, currentFileBasename) {
  if (!rawUrl) return null;
  let url = rawUrl.trim();

  // 外部絕對連結 (http://, https://, mailto:)
  if (/^(https?:\/\/|mailto:)/i.test(url)) {
    return url;
  }

  let decoded = decodeURIComponent(url);

  // 頁面內錨點 (#anchor)
  if (decoded.startsWith('#')) {
    const currentPageId = PAGE_MAP[currentFileBasename];
    if (currentPageId) {
      const pageIdNoDash = currentPageId.replace(/-/g, '');
      return encodeURI(`https://www.notion.so/${pageIdNoDash}${decoded}`);
    }
    return null;
  }

  // 本地相對 Markdown 檔案連結 (例如 ./01-機票住宿.md)
  let hash = '';
  if (decoded.includes('#')) {
    const parts = decoded.split('#');
    decoded = parts[0];
    hash = '#' + parts.slice(1).join('#');
  }

  const filename = path.basename(decoded);
  let targetKey = PAGE_MAP[filename] ? filename : null;
  if (!targetKey) {
    const prefix = filename.split('-')[0];
    if (prefix && /^\d+$/.test(prefix)) {
      targetKey = Object.keys(PAGE_MAP).find(k => k.startsWith(prefix + '-'));
    }
  }

  if (targetKey && PAGE_MAP[targetKey]) {
    const targetPageId = PAGE_MAP[targetKey].replace(/-/g, '');
    return encodeURI(`https://www.notion.so/${targetPageId}${hash}`);
  }

  return url;
}

// 4. 解析 Rich Text (遞迴處理嵌套標籤 **粗體**, `程式碼`, *斜體*, [連結](url))
function parseRichText(text, currentFileBasename, state = {}) {
  if (!text) return [];

  const results = [];

  const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/;
  const BOLD_REGEX = /\*\*(.*?)\*\*/;
  const CODE_REGEX = /`([^`]+)`/;
  const ITALIC_REGEX = /\*(.*?)\*/;

  let remaining = text;

  while (remaining.length > 0) {
    const linkMatch = LINK_REGEX.exec(remaining);
    const boldMatch = BOLD_REGEX.exec(remaining);
    const codeMatch = CODE_REGEX.exec(remaining);
    const italicMatch = ITALIC_REGEX.exec(remaining);

    const matches = [];
    if (linkMatch) matches.push({ type: 'link', match: linkMatch, index: linkMatch.index });
    if (boldMatch) matches.push({ type: 'bold', match: boldMatch, index: boldMatch.index });
    if (codeMatch) matches.push({ type: 'code', match: codeMatch, index: codeMatch.index });
    if (italicMatch) matches.push({ type: 'italic', match: italicMatch, index: italicMatch.index });

    if (matches.length === 0) {
      const item = { type: 'text', text: { content: remaining } };
      if (state.linkUrl) item.text.link = { url: state.linkUrl };
      const annotations = {};
      if (state.bold) annotations.bold = true;
      if (state.code) annotations.code = true;
      if (state.italic) annotations.italic = true;
      if (Object.keys(annotations).length > 0) item.annotations = annotations;
      results.push(item);
      break;
    }

    matches.sort((a, b) => a.index - b.index);
    const earliest = matches[0];

    if (earliest.index > 0) {
      const plainText = remaining.slice(0, earliest.index);
      const item = { type: 'text', text: { content: plainText } };
      if (state.linkUrl) item.text.link = { url: state.linkUrl };
      const annotations = {};
      if (state.bold) annotations.bold = true;
      if (state.code) annotations.code = true;
      if (state.italic) annotations.italic = true;
      if (Object.keys(annotations).length > 0) item.annotations = annotations;
      results.push(item);
    }

    const m = earliest.match;
    if (earliest.type === 'link') {
      const linkLabel = m[1];
      const rawUrl = m[2];
      const resolved = resolveUrl(rawUrl, currentFileBasename);
      const subState = { ...state, linkUrl: resolved || state.linkUrl };
      results.push(...parseRichText(linkLabel, currentFileBasename, subState));
    } else if (earliest.type === 'bold') {
      const innerText = m[1];
      const subState = { ...state, bold: true };
      results.push(...parseRichText(innerText, currentFileBasename, subState));
    } else if (earliest.type === 'code') {
      const innerText = m[1];
      const subState = { ...state, code: true };
      results.push(...parseRichText(innerText, currentFileBasename, subState));
    } else if (earliest.type === 'italic') {
      const innerText = m[1];
      const subState = { ...state, italic: true };
      results.push(...parseRichText(innerText, currentFileBasename, subState));
    }

    remaining = remaining.slice(earliest.index + m[0].length);
  }

  return results.length > 0 ? results : [{ type: 'text', text: { content: text } }];
}

// 5. 解析 Markdown 行為 Notion 區塊結構
function markdownToBlocks(content, fileBasename) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 分隔線
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++;
      continue;
    }

    // 標題 1~3
    if (trimmed.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: parseRichText(trimmed.slice(2).trim(), fileBasename) }
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: parseRichText(trimmed.slice(3).trim(), fileBasename) }
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: parseRichText(trimmed.slice(4).trim(), fileBasename) }
      });
      i++;
      continue;
    }

    // 引用 / Callout
    if (trimmed.startsWith('> ')) {
      const quoteText = trimmed.slice(2).trim();
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseRichText(quoteText, fileBasename) }
      });
      i++;
      continue;
    }

    // 待辦事項 (Checkboxes)
    if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ')) {
      const checked = trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ');
      const todoText = trimmed.slice(6).trim();
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: parseRichText(todoText, fileBasename), checked: checked }
      });
      i++;
      continue;
    }

    // 無序清單 (- 或 *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const bulletText = trimmed.slice(2).trim();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(bulletText, fileBasename) }
      });
      i++;
      continue;
    }

    // 表格解析 (| ... |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableRows = [];
      let width = 0;
      let hasHeaderDivider = false;

      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const rowLine = lines[i].trim();
        // 判斷是否為表格分隔行 (| :--- | :--- |)
        if (/^\|(\s*:?-+:?\s*\|)+$/.test(rowLine)) {
          hasHeaderDivider = true;
          i++;
          continue;
        }

        const cells = rowLine
          .slice(1, -1)
          .split('|')
          .map(cell => parseRichText(cell.trim().replace(/<br\s*\/?>/gi, '\n'), fileBasename));

        if (width === 0) width = cells.length;

        tableRows.push({
          type: 'table_row',
          table_row: { cells: cells }
        });
        i++;
      }

      if (tableRows.length > 0) {
        blocks.push({
          object: 'block',
          type: 'table',
          table: {
            table_width: width,
            has_column_header: hasHeaderDivider,
            has_row_header: false,
            children: tableRows
          }
        });
      }
      continue;
    }

    // 一般段落
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: parseRichText(trimmed, fileBasename) }
    });
    i++;
  }

  return blocks;
}

// 5. 輔助函式：包裝 fetch 支援 429 頻率限制與網路錯誤自動指數退避重試
async function fetchWithRetry(url, options = {}, maxRetries = 5, initialDelay = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : initialDelay * Math.pow(2, attempt - 1);
        console.warn(`⏳ Notion API 觸發頻率限制 (429)，等待 ${delay}ms 後重試 (第 ${attempt}/${maxRetries} 次)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = initialDelay * Math.pow(2, attempt - 1);
      console.warn(`⚠️ 網路請求異常 (${err.message})，等待 ${delay}ms 後重試...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// 6. 狀態快取與雜湊輔助函式
const STATE_FILE = path.join(__dirname, '..', '.notion-sync-state.json');

function loadSyncState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveSyncState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ 儲存同步狀態快取失敗:', e.message);
  }
}

function computeFileHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// 7. 區塊簽名與比對函式
function getRichTextPlainText(richTextList) {
  if (!Array.isArray(richTextList)) return '';
  return richTextList.map(r => r.plain_text ?? r.text?.content ?? '').join('');
}

function normalizeRichTextList(richText) {
  if (!Array.isArray(richText) || richText.length === 0) return '';
  return richText.map(r => {
    const text = (r.plain_text ?? r.text?.content ?? '').trim();
    const link = r.text?.link?.url ?? r.href ?? '';
    const bold = !!r.annotations?.bold;
    const italic = !!r.annotations?.italic;
    const code = !!r.annotations?.code;
    return `[${text}|${link}|b:${bold ? 1 : 0}|i:${italic ? 1 : 0}|c:${code ? 1 : 0}]`;
  }).join('');
}

function getBlockSignature(block) {
  if (!block || !block.type) return '';
  const type = block.type;
  if (type === 'divider') return 'divider';
  if (type === 'child_page' || type === 'child_database') return `${type}:${block.id}`;

  const content = block[type];
  if (!content) return type;

  if (type === 'to_do') {
    const checked = content.checked ? '1' : '0';
    return `to_do:${checked}:${normalizeRichTextList(content.rich_text)}`;
  }

  if (type === 'table') {
    return `table:${content.table_width}:${content.has_column_header ? '1' : '0'}`;
  }

  if (content.rich_text) {
    return `${type}:${normalizeRichTextList(content.rich_text)}`;
  }

  return type;
}

// 8. LCS 最長公共子序列算法 (找出未變動錨點)
function computeLCSMatches(arr1, arr2, getKey) {
  const m = arr1.length;
  const n = arr2.length;
  if (m === 0 || n === 0) return [];

  const keys1 = arr1.map(getKey);
  const keys2 = arr2.map(getKey);

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (keys1[i - 1] === keys2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const matches = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (keys1[i - 1] === keys2[j - 1]) {
      matches.push({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches.reverse();
}

// 9. Notion API 操作包裝
async function fetchAllExistingBlocks(pageId, headers) {
  const existingBlocks = [];
  let cursor = undefined;

  while (true) {
    let url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`;
    if (cursor) {
      url += `&start_cursor=${encodeURIComponent(cursor)}`;
    }

    const res = await fetchWithRetry(url, { headers });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`無法讀取頁面區塊 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (data.results && data.results.length > 0) {
      existingBlocks.push(...data.results);
    }

    if (!data.has_more || !data.next_cursor) {
      break;
    }
    cursor = data.next_cursor;
  }

  return existingBlocks;
}

async function patchBlock(blockId, newBlock, headers) {
  const type = newBlock.type;
  const payload = {
    [type]: newBlock[type]
  };
  const res = await fetchWithRetry(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(payload)
  });
  if (!res || !res.ok) {
    const errText = res ? await res.text() : 'No response';
    throw new Error(`更新 Notion 區塊 ${blockId} 失敗: ${errText}`);
  }
}

async function deleteBlock(blockId, headers) {
  const res = await fetchWithRetry(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'DELETE',
    headers
  });
  if (!res || !res.ok) {
    const errText = res ? await res.text() : 'No response';
    console.warn(`⚠️ 刪除區塊 ${blockId} 失敗:`, errText);
  }
}

async function insertBlocks(pageId, blocks, afterId, headers) {
  const chunkSize = 100;
  const createdIds = [];
  let currentAfter = afterId;

  for (let c = 0; c < blocks.length; c += chunkSize) {
    const chunk = blocks.slice(c, c + chunkSize);
    const body = { children: chunk };
    if (currentAfter) {
      body.after = currentAfter;
    }
    const res = await fetchWithRetry(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body)
    });
    if (!res || !res.ok) {
      const errText = res ? await res.text() : 'No response';
      throw new Error(`寫入 Notion 區塊失敗: ${errText}`);
    }
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      for (const b of data.results) {
        createdIds.push(b.id);
      }
      currentAfter = data.results[data.results.length - 1].id;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  return createdIds;
}

// 全量覆寫降級備援
async function fullWipeAndWrite(pageId, blocks, headers, existingBlocksToDelete) {
  if (existingBlocksToDelete.length > 0) {
    console.log(`   🧹 [全量覆寫] 正在清除 ${existingBlocksToDelete.length} 個舊區塊...`);
    for (let idx = 0; idx < existingBlocksToDelete.length; idx++) {
      await deleteBlock(existingBlocksToDelete[idx].id, headers);
      if (idx % 10 === 0 && idx > 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  console.log(`   ✍️ [全量覆寫] 正在寫入 ${blocks.length} 個新區塊...`);
  await insertBlocks(pageId, blocks, null, headers);
  console.log(`   📊 同步統計: 全量覆寫 ${blocks.length} 個區塊`);
}

// 10. 增量 Diff 同步核心引擎
async function incrementalUpdatePage(pageId, manageableExisting, newBlocks, headers) {
  const matches = computeLCSMatches(manageableExisting, newBlocks, getBlockSignature);
  const matchRatio = matches.length / Math.max(manageableExisting.length, newBlocks.length, 1);

  console.log(`   🔍 區塊比對分析: 現有 ${manageableExisting.length} 個，新版 ${newBlocks.length} 個，完全一致 ${matches.length} 個 (相似度: ${(matchRatio * 100).toFixed(1)}%)`);

  // 若比對一致度過低，降級為全量覆寫模式以確保排版正確
  if (manageableExisting.length > 0 && matchRatio < 0.25) {
    console.log(`   ⚠️ 頁面結構變動超過 75%，切換為全量覆寫模式以確保排版正確...`);
    return await fullWipeAndWrite(pageId, newBlocks, headers, manageableExisting);
  }

  let stats = { kept: matches.length, patched: 0, inserted: 0, deleted: 0 };

  const intervals = [];
  let prevOld = 0;
  let prevNew = 0;

  for (const match of matches) {
    intervals.push({
      oldChunk: manageableExisting.slice(prevOld, match.oldIdx),
      newChunk: newBlocks.slice(prevNew, match.newIdx),
      anchor: manageableExisting[match.oldIdx]
    });
    prevOld = match.oldIdx + 1;
    prevNew = match.newIdx + 1;
  }

  intervals.push({
    oldChunk: manageableExisting.slice(prevOld),
    newChunk: newBlocks.slice(prevNew),
    anchor: null
  });

  let currentAfterId = null;

  for (let idx = 0; idx < intervals.length; idx++) {
    const { oldChunk, newChunk, anchor } = intervals[idx];

    if (oldChunk.length > 0 || newChunk.length > 0) {
      if (idx === 0 && oldChunk.length === 0 && newChunk.length > 0 && !currentAfterId) {
        console.log(`   ℹ️ 文件開頭新增區塊無前置錨點，切換為全量覆寫模式...`);
        return await fullWipeAndWrite(pageId, newBlocks, headers, manageableExisting);
      }

      const pairCount = Math.min(oldChunk.length, newChunk.length);

      // 1. 成對更新 / 替換
      for (let k = 0; k < pairCount; k++) {
        const oldB = oldChunk[k];
        const newB = newChunk[k];

        if (oldB.type === newB.type && oldB.type !== 'table' && oldB.type !== 'divider') {
          await patchBlock(oldB.id, newB, headers);
          stats.patched++;
          currentAfterId = oldB.id;
        } else {
          await deleteBlock(oldB.id, headers);
          stats.deleted++;
          const insertedIds = await insertBlocks(pageId, [newB], currentAfterId, headers);
          stats.inserted++;
          if (insertedIds.length > 0) {
            currentAfterId = insertedIds[insertedIds.length - 1];
          }
        }
      }

      // 2. newChunk 多出的區塊（新增插入）
      if (newChunk.length > pairCount) {
        const extraNew = newChunk.slice(pairCount);
        const insertedIds = await insertBlocks(pageId, extraNew, currentAfterId, headers);
        stats.inserted += extraNew.length;
        if (insertedIds.length > 0) {
          currentAfterId = insertedIds[insertedIds.length - 1];
        }
      }

      // 3. oldChunk 多出的區塊（刪除）
      if (oldChunk.length > pairCount) {
        const extraOld = oldChunk.slice(pairCount);
        for (const b of extraOld) {
          await deleteBlock(b.id, headers);
          stats.deleted++;
        }
      }
    }

    if (anchor) {
      currentAfterId = anchor.id;
    }
  }

  console.log(`   📊 同步統計: 保留 ${stats.kept} 個 | 原地更新 ${stats.patched} 個 | 新增 ${stats.inserted} 個 | 刪除 ${stats.deleted} 個`);
}

// 11. 互動詢問與預覽輔助函式
async function askUserChoice(questionPrompt, validChoices = ['o', 'p', 'a'], defaultChoice = 'a') {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(questionPrompt, answer => {
      rl.close();
      const choice = (answer || '').trim().toLowerCase();
      resolve(validChoices.includes(choice) ? choice : defaultChoice);
    });
  });
}

async function previewRemotePage(pageId, headers) {
  try {
    const res = await fetchWithRetry(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=15`, { headers });
    if (!res || !res.ok) {
      console.log('   (無法讀取線上區塊預覽)');
      return;
    }
    const data = await res.json();
    console.log('\n--- [Notion 線上前 15 個區塊預覽] ---');
    (data.results || []).slice(0, 15).forEach((b, idx) => {
      const type = b.type;
      const content = b[type];
      let text = '';
      if (content?.rich_text) {
        text = getRichTextPlainText(content.rich_text);
      }
      console.log(` ${idx + 1}. [${type}] ${text.slice(0, 80)}`);
    });
    console.log('-------------------------------------------\n');
  } catch (err) {
    console.log(`   (預覽失敗: ${err.message})`);
  }
}

// 12. 主同步入口
async function main() {
  if (!NOTION_TOKEN) {
    console.log('ℹ️ 未檢測到 NOTION_TOKEN 環境變數。請在專案根目錄建立 .env 設定 NOTION_TOKEN=secret_xxx。');
    process.exit(0);
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  const args = process.argv.slice(2);
  const isForce = args.includes('--force') || args.includes('-f');
  const isFull = args.includes('--full');
  const isGit = args.includes('--git');
  const isAll = args.includes('--all');

  let filesToSync = [];

  if (isGit) {
    try {
      const gitDiff = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf-8' });
      filesToSync = gitDiff.split('\n').map(f => f.trim()).filter(f => PAGE_MAP[f]);
    } catch (e) {
      console.log('⚠️ 讀取 Git 異動歷史失敗，切換為掃描全部檔案。');
      filesToSync = Object.keys(PAGE_MAP);
    }
  } else if (isAll || args.length === 0 || (args.length === 1 && (isForce || isFull))) {
    filesToSync = Object.keys(PAGE_MAP);
  } else {
    filesToSync = args.filter(f => PAGE_MAP[f]);
  }

  if (filesToSync.length === 0) {
    console.log('✅ 無需同步的 Markdown 檔案。');
    return;
  }

  const syncState = loadSyncState();
  console.log(`🚀 開始檢查並同步 ${filesToSync.length} 個檔案至 Notion (增量 Diff 模式)...`);

  for (const filename of filesToSync) {
    const pageId = PAGE_MAP[filename];
    const filePath = path.join(__dirname, '..', filename);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const currentHash = computeFileHash(content);
    const fileState = syncState[filename];

    console.log(`\n⏳ 檢查檔案: ${filename} -> Notion (${pageId})...`);

    // 檢查線上頁面最後編輯時間
    let remoteLastEdited = null;
    try {
      const pageRes = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, { method: 'GET', headers });
      if (pageRes && pageRes.ok) {
        const pageData = await pageRes.json();
        remoteLastEdited = pageData.last_edited_time;
      }
    } catch (err) {
      console.warn(`   ⚠️ 無法獲取線上頁面資訊: ${err.message}`);
    }

    // 線上與本地變更檢測
    let isRemoteChanged = false;
    let isLocalChanged = !fileState || fileState.fileHash !== currentHash;

    if (fileState && fileState.notionLastEditedTime && remoteLastEdited) {
      const remoteTime = new Date(remoteLastEdited).getTime();
      const localSyncedTime = new Date(fileState.notionLastEditedTime).getTime();
      // 容許 5 秒誤差
      if (remoteTime > localSyncedTime + 5000) {
        isRemoteChanged = true;
      }
    }

    // 若本地無變更且未強制同步
    if (!isLocalChanged && !isForce) {
      if (isRemoteChanged) {
        console.log(`   ℹ️ 本地無變更，但 Notion 線上有更新 (${remoteLastEdited})。若欲覆蓋請加上 --force。`);
      } else {
        console.log(`   ⏩ 本地與線上皆無變更，跳過此檔案。`);
      }
      continue;
    }

    // 若偵測到線上亦有修改（衝突保護）
    if (isRemoteChanged && !isForce) {
      console.warn(`   ⚠️ [線上衝突] 檢測到 Notion 線上頁面在上次同步後亦有修改！`);
      console.warn(`      線上最後編輯時間: ${remoteLastEdited}`);
      console.warn(`      上次同步基準時間: ${fileState.notionLastEditedTime}`);

      if (process.stdin.isTTY) {
        let resolved = false;
        while (!resolved) {
          const choice = await askUserChoice(
            '   請選擇處理方式: [O] 強制以本地覆蓋 / [P] 預覽線上內容 / [A] 放棄同步 (預設 A): ',
            ['o', 'p', 'a'],
            'a'
          );

          if (choice === 'p') {
            await previewRemotePage(pageId, headers);
          } else if (choice === 'o') {
            console.log('   ⏩ 使用者確認覆蓋線上變更，繼續同步...');
            resolved = true;
          } else {
            console.log('   🛑 放棄同步此檔案。');
            resolved = true;
            continue;
          }
        }
        // 如果使用者選擇放棄
        if (!resolved) continue;
      } else {
        console.warn(`   ⚠️ [安全跳過] 非互動環境下檢測到線上衝突，為保護線上編輯已略過此檔案。`);
        console.warn(`   👉 請在終端機執行 npm run sync 進行確認，或加上 --force 強制覆蓋。`);
        continue;
      }
    }

    const blocks = markdownToBlocks(content, filename);

    try {
      if (isFull) {
        console.log(`   ⚡ 強制全量覆寫模式啟用...`);
        const existingBlocks = await fetchAllExistingBlocks(pageId, headers);
        const manageableExisting = existingBlocks.filter(
          b => b.type !== 'child_page' && b.type !== 'child_database'
        );
        await fullWipeAndWrite(pageId, blocks, headers, manageableExisting);
      } else {
        const existingBlocks = await fetchAllExistingBlocks(pageId, headers);
        const manageableExisting = existingBlocks.filter(
          b => b.type !== 'child_page' && b.type !== 'child_database'
        );
        await incrementalUpdatePage(pageId, manageableExisting, blocks, headers);
      }

      // 同步完成後更新快取狀態
      const afterRes = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, { method: 'GET', headers });
      const afterData = afterRes && afterRes.ok ? await afterRes.json() : null;

      syncState[filename] = {
        fileHash: currentHash,
        notionPageId: pageId,
        lastSyncedAt: new Date().toISOString(),
        notionLastEditedTime: afterData?.last_edited_time || new Date().toISOString()
      };
      saveSyncState(syncState);

      console.log(`✨ 成功同步 ${filename}！`);
    } catch (err) {
      console.error(`❌ 同步 ${filename} 失敗:`, err.message);
    }
  }

  console.log('\n🎉 Notion 同步處理完成！');
}

main().catch(console.error);

