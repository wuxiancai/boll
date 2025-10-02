const puppeteer = require('puppeteer');
const path = require('path');
let PNG;
let COLOR_OCR = false;
try {
  ({ PNG } = require('pngjs'));
  COLOR_OCR = true;
} catch (e) {
  COLOR_OCR = false;
  console.log('未安装 pngjs，跳过按颜色OCR，将使用整图识别（可运行 npm install 以启用颜色识别）。');
}
const { createWorker } = require('tesseract.js');

const URL = 'https://www.binance.com/zh-CN/futures/BTCUSDT';

function extractBOLL(text) {
  if (!text) return null;
  const t = String(text);
  // 1) 优先按标签顺序提取：UP / MB / DN 后的大数（带千位分隔）
  const labelPattern = /UP[^\d-]*([\d.,]+)[\s\S]*?MB[^\d-]*([\d.,]+)[\s\S]*?DN[^\d-]*([\d.,]+)/i;
  const m = t.match(labelPattern);
  if (m) return { upper: m[1], middle: m[2], lower: m[3] };
  // 2) 兜底：若包含 BOLL 文案，取前三个带千位分隔的大数
  if (/(BOLL|Bollinger|布林)/i.test(t)) {
    const grouped = t.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g) || [];
    if (grouped.length >= 3) {
      return { upper: grouped[0], middle: grouped[1], lower: grouped[2] };
    }
  }
  return null;
}

// 颜色范围匹配（RGB），用于分离白/黄/蓝三色数字
function inRange(r, g, b, range) {
  return (
    r >= range.min[0] && r <= range.max[0] &&
    g >= range.min[1] && g <= range.max[1] &&
    b >= range.min[2] && b <= range.max[2]
  );
}

function maskByRange(buffer, range) {
  const src = PNG.sync.read(buffer);
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i];
    const g = src.data[i + 1];
    const b = src.data[i + 2];
    const a = src.data[i + 3];
    if (a > 0 && inRange(r, g, b, range)) {
      out.data[i] = 255; // 白色前景
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
      out.data[i + 3] = 255;
    } else {
      out.data[i] = 0; // 黑色背景
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      out.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}

function extractNumeric(text) {
  if (!text) return null;
  const t = String(text);
  // 优先匹配带千位分隔的大数
  const m1 = t.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/);
  if (m1) return m1[0];
  // 兜底匹配普通小数
  const m2 = t.match(/\b\d+(?:\.\d+)?\b/);
  return m2 ? m2[0] : null;
}

async function main() {
  // 极简流程：启动浏览器 -> 等待5秒 -> 截图 -> OCR -> 打印 -> 循环
  const HEADLESS = process.env.HEADLESS !== 'false';
  const START_DELAY_MS = 5000;
  const CAPTURE_INTERVAL_MS = parseInt(process.env.CAPTURE_INTERVAL_MS || '1000', 10);

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${path.resolve(__dirname, 'chrome')}`,
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });

  console.log(`已打开页面，等待 ${START_DELAY_MS}ms 后开始截图与识别... (Ctrl+C 退出)`);
  await new Promise(res => setTimeout(res, START_DELAY_MS));

  const worker = await createWorker({ logger: () => {} });
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: 'UPMBDN0123456789., ',
  });

  while (true) {
    const loopStart = Date.now();
    try {
      // 固定坐标裁剪截图到项目目录 1.png（覆盖保存）
      const img = await page.screenshot({
        path: path.resolve(__dirname, '1.png'),
        clip: { x: 15, y: 260, width: 400, height: 50 }
      });
      let vals = null;
      if (COLOR_OCR) {
        // 颜色分离：白(上轨) / 黄(中轨) / 蓝(下轨)
        const WHITE = { min: [230, 230, 230], max: [255, 255, 255] };
        const YELLOW = { min: [220, 170, 0],   max: [255, 255, 90]  };
        const BLUE = { min: [0, 120, 180],     max: [100, 220, 255] };

        const whiteBuf = maskByRange(img, WHITE);
        const yellowBuf = maskByRange(img, YELLOW);
        const blueBuf = maskByRange(img, BLUE);

        // 识别数字（只允许数字和分隔符，提高稳定性）
        await worker.setParameters({
          tessedit_pageseg_mode: '7',
          tessedit_char_whitelist: '0123456789.,'
        });
        const [wData, yData, bData] = await Promise.all([
          worker.recognize(whiteBuf),
          worker.recognize(yellowBuf),
          worker.recognize(blueBuf)
        ]);

        let upper = extractNumeric(wData.data.text || '');
        let middle = extractNumeric(yData.data.text || '');
        let lower = extractNumeric(bData.data.text || '');

        // 若任意颜色识别失败，回退到整图文本 + 标签解析
        if (upper && middle && lower) {
          vals = { upper, middle, lower };
        } else {
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: 'UPMBDN0123456789., '
          });
          const full = await worker.recognize(img);
          vals = extractBOLL(full.data.text || '');
        }
      } else {
        // 无 pngjs 时的回退：直接整图 OCR + 标签解析
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: 'UPMBDN0123456789., '
        });
        const full = await worker.recognize(img);
        vals = extractBOLL(full.data.text || '');
      }
      const ts = new Date().toISOString().replace('T',' ').slice(0,19);
      if (vals) {
        console.log(`[${ts}] BOLL 上轨:${vals.upper} 中轨:${vals.middle} 下轨:${vals.lower}`);
      } else {
        console.log(`[${ts}] BOLL 上轨:none 中轨:none 下轨:none`);
      }
    } catch (e) {
      const ts = new Date().toISOString().replace('T',' ').slice(0,19);
      console.log(`[${ts}] 发生错误: ${e.message}`);
    }
    const elapsed = Date.now() - loopStart;
    const waitMs = Math.max(0, CAPTURE_INTERVAL_MS - elapsed);
    await new Promise(res => setTimeout(res, waitMs));
  }
}

main().catch(err => {
  console.error('程序异常:', err);
  process.exit(1);
});