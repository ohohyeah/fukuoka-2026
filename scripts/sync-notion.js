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

// 3. 解析 Rich Text (處理 **粗體**, `程式碼`, [連結](url))
function parseRichText(text) {
  if (!text) return [];
  const result = [];
  // 簡化連環正則解析
  const regex = /(\*\*(.*?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({
        type: 'text',
        text: { content: text.slice(lastIndex, match.index) }
      });
    }

    if (match[2] !== undefined) {
      // 粗體 **text**
      result.push({
        type: 'text',
        text: { content: match[2] },
        annotations: { bold: true }
      });
    } else if (match[3] !== undefined) {
      // 程式碼 `code`
      result.push({
        type: 'text',
        text: { content: match[3] },
        annotations: { code: true }
      });
    } else if (match[4] !== undefined && match[5] !== undefined) {
      // 連結 [text](url)
      result.push({
        type: 'text',
        text: { content: match[4], link: { url: match[5] } }
      });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push({
      type: 'text',
      text: { content: text.slice(lastIndex) }
    });
  }

  return result.length > 0 ? result : [{ type: 'text', text: { content: text } }];
}

// 4. 解析 Markdown 行為 Notion 區塊結構
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
        heading_1: { rich_text: parseRichText(trimmed.slice(2).trim()) }
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: parseRichText(trimmed.slice(3).trim()) }
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: parseRichText(trimmed.slice(4).trim()) }
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
        quote: { rich_text: parseRichText(quoteText) }
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
        to_do: { rich_text: parseRichText(todoText), checked: checked }
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
        bulleted_list_item: { rich_text: parseRichText(bulletText) }
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
          .map(cell => parseRichText(cell.trim().replace(/<br\s*\/?>/gi, '\n')));

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
      paragraph: { rich_text: parseRichText(trimmed) }
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
