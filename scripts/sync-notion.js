const fs = require('fs');
const path = require('path');
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

// 5. 調用 Notion API 清空與更新區塊
async function updateNotionPage(pageId, blocks, fileBasename) {
  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  // 取得頁面上所有現有區塊
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`無法讀取頁面區塊 (${res.status}): ${errText}`);
  }

  const existingData = await res.json();
  const existingBlocks = existingData.results || [];

  // 清理非子頁面的既有區塊
  for (const block of existingBlocks) {
    if (block.type === 'child_page' || block.type === 'child_database') {
      // 保留 Notion 中的子頁面
      continue;
    }
    await fetch(`https://api.notion.com/v1/blocks/${block.id}`, {
      method: 'DELETE',
      headers
    });
  }

  // 分批寫入新區塊 (每次上限 100)
  const chunkSize = 100;
  for (let c = 0; c < blocks.length; c += chunkSize) {
    const chunk = blocks.slice(c, c + chunkSize);
    const appendRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ children: chunk })
    });

    if (!appendRes.ok) {
      const errText = await appendRes.text();
      console.error(`⚠️ 寫入 Notion 區塊失敗 (${appendRes.status}):`, errText);
    }
  }
}

// 6. 主同步入口
async function main() {
  if (!NOTION_TOKEN) {
    console.log('ℹ️ 未檢測到 NOTION_TOKEN 環境變數。請在專案根目錄建立 .env 設定 NOTION_TOKEN=secret_xxx。');
    process.exit(0);
  }

  const args = process.argv.slice(2);
  let filesToSync = [];

  if (args.includes('--git')) {
    // 從最新 Git commit 檢測異動檔
    try {
      const gitDiff = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf-8' });
      filesToSync = gitDiff.split('\n').map(f => f.trim()).filter(f => PAGE_MAP[f]);
    } catch (e) {
      console.log('⚠️ 讀取 Git 異動歷史失敗，切換為全量同步模式。');
      filesToSync = Object.keys(PAGE_MAP);
    }
  } else if (args.includes('--all') || args.length === 0) {
    filesToSync = Object.keys(PAGE_MAP);
  } else {
    filesToSync = args.filter(f => PAGE_MAP[f]);
  }

  if (filesToSync.length === 0) {
    console.log('✅ 無需同步的 Markdown 檔案。');
    return;
  }

  console.log(`🚀 開始同步 ${filesToSync.length} 個檔案至 Notion...`);

  for (const filename of filesToSync) {
    const pageId = PAGE_MAP[filename];
    const filePath = path.join(__dirname, '..', filename);
    if (!fs.existsSync(filePath)) continue;

    console.log(`⏳ 正在同步: ${filename} -> Notion (${pageId})...`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = markdownToBlocks(content, filename);

    try {
      await updateNotionPage(pageId, blocks, filename);
      console.log(`✨ 成功同步 ${filename}！`);
    } catch (err) {
      console.error(`❌ 同步 ${filename} 失敗:`, err.message);
    }
  }

  console.log('🎉 Notion 同步完成！');
}

main().catch(console.error);
