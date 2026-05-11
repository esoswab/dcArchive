require('dotenv').config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const urlLib = require("url");
const crypto = require("crypto");
const sharp = require("sharp");

// ── 설정 및 상수 ───────────────────────────────────────────
const PORT = process.env.PORT || 1557;
const SOURCE = "https://gall.dcinside.com";
const NOTIFICATION_URL = process.env.NOTIFICATION_URL;

async function sendAlert(msg) {
  if (!NOTIFICATION_URL) return;
  try {
    await fetch(NOTIFICATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `[DC Archive Alert] ${msg}` })
    });
  } catch (e) { console.error("[Alert Failed]", e.message); }
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// ── 디스코드 봇 (커맨드 센터) ──────────────────────────────
let discordClient = null;
try {
  const { Client, GatewayIntentBits } = require('discord.js');
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  discordClient.on('ready', () => {
    console.log(`[Discord] 봇 로그인 성공: ${discordClient.user.tag}`);
    sendAlert("✅ 서버 및 디스코드 봇이 가동되었습니다. 이제 디코에서 명령어를 사용하실 수 있습니다.");
  });

  discordClient.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith('!')) return;

    const args = msg.content.slice(1).split(' ');
    const command = args.shift().toLowerCase();

    if (command === '상태') {
      const stats = await dbMgr.get("SELECT COUNT(*) as total, SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) as deleted FROM posts");
      msg.reply(`📊 **아카이브 현황**\n- 전체 게시글: ${stats.total}개\n- 삭제된 글: ${stats.deleted}개\n- IP 차단 상태: ${isIpThrottled ? '🔴 차단됨' : '🟢 정상'}`);
    }

    if (command === '감시' && args[0]) {
      const no = args[0];
      if (!WATCH_LIST.includes(no)) {
        WATCH_LIST.push(no);
        saveWatchList();
        msg.reply(`⭐ 글 번호 **${no}**를 감시 목록에 추가했습니다.`);
        processItem({ no, href: buildDcUrl(no, 1), type: 'notice' }, SOURCE + '/').catch(() => { });
      } else {
        msg.reply(`이미 감시 중인 글입니다.`);
      }
    }

    if (command === '갱신' && args[0]) {
      const no = args[0];
      msg.reply(`🔄 글 번호 **${no}** 수동 갱신을 시작합니다...`);
      await processItem({ no, href: buildDcUrl(no, 1), type: 'notice' }, SOURCE + '/');
      msg.reply(`✅ 갱신 완료!`);
    }

    if (command === '시작') {
      isIpThrottled = false;
      msg.reply(`🟢 수집을 시작(재개)합니다! 🚀`);
    }

    if (command === '중지') {
      isIpThrottled = true;
      msg.reply(`🛑 수집을 즉시 중단했습니다. (안전 모드)`);
    }

    if (command === '종료') {
      await msg.reply(`🛑 서버를 완전히 종료합니다. 다시 켜려면 터미널에서 직접 명령어를 입력해야 합니다. 안녕히 계세요!`);
      const { exec } = require('child_process');
      exec('pm2 stop dc'); // PM2에게 직접 중단 명령을 내립니다.
    }

    if (command === 'ㄱㄷ' || command === '재시작') {
      await msg.reply(`🔄 서버를 재시작합니다. 잠시만 기다려 주세요...`);
      console.log("[Discord] 사용자에 의한 강제 재시작 요청");
      process.exit(0); // PM2가 자동으로 다시 켜줍니다.
    }

    if (command === '풀기') {
      isIpThrottled = false;
      msg.reply(`🟢 IP 차단 모드를 강제로 해제했습니다. 수집을 재개합니다.`);
    }

    if (command === '도움말' || command === '명령어' || command === 'help') {
      msg.reply(`🛠️ **명령어 목록**\n- \`!상태\`: 서버 현황 확인\n- \`!감시 [번호]\`: 글 감시 목록 추가\n- \`!갱신 [번호]\`: 글 수동 갱신\n- \`!시작 / !중지\`: 수집 가동/정지\n- \`!ㄱㄷ\`: 서버 재시작\n- \`!종료\`: 서버 완전 종료\n- \`!명령어\`: 이 도움말 보기`);
    }
  });

  discordClient.login(DISCORD_TOKEN).catch(e => console.error("[Discord] 봇 로그인 실패:", e.message));
} catch (e) {
  console.log("[Discord] discord.js가 설치되지 않아 봇 기능을 건너뜁니다.");
}
const CACHE_FILE = "archive-cache.json";
const MEDIA_DIR = path.join(__dirname, "media-cache");
const INDEX = path.join(__dirname, "index.html");
const ERROR_LOG = path.join(__dirname, "error.log");
const dbMgr = require("./db-manager");

// ── 성능 및 안정성 설정 ─────────────────────────────────────────
const BEST_REFRESH_LIMIT = 200;    // 주기적 '갱신' 최대 개수 (최신 글 감시 범위 포함)
const CRAWL_PAGES = 10;           // 기본 크롤링 페이지 수
sharp.cache(false);               // Sharp 메모리 캐시 비활성화 (메모리 누수 방지)
sharp.concurrency(1);             // 동시 처리 제한 (CPU/RAM 폭증 방지)

// ── 전역 에러 핸들러 (서버 다운 방지 및 기록) ──────────────────
function logError(err, type = "Error") {
  const msg = `[${new Date().toLocaleString()}] [${type}] ${err.stack || err}\n`;
  console.error(msg);
  fs.appendFileSync(ERROR_LOG, msg);
}
process.on('uncaughtException', (err) => logError(err, "UncaughtException"));
process.on('unhandledRejection', (reason) => logError(reason, "UnhandledRejection"));

// [DB 초기화 및 청소]
(async () => {
  await dbMgr.init();
  // 🚨 잘못 분류된 개념글 청소 (추천 0인데 개념글인 경우 일반글로 환원)
  const result = await dbMgr.run("UPDATE posts SET type = 'normal' WHERE type = 'best' AND likes = 0");
  if (result.changes > 0) console.log(`[System] 잘못 분류된 개념글 ${result.changes}개를 일반글로 복구했습니다.`);
  console.log('[System] 데이터베이스 연결 및 초기화 완료');
})();

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ── 유틸리티 ───────────────────────────────────────────────
function decodeEntities(text) {
  if (!text) return "";
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(html) {
  if (!html) return "";
  let clean = html.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/gi, "");
  return clean.replace(/<[^>]*>?/gm, "").trim();
}
function jitterWait(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 이미지 로컬 캐싱 ─────────────────────────────────────────
async function cacheImage(url, referer) {
  const hash = require('crypto').createHash('md5').update(url).digest('hex');
  const outPath = path.join(MEDIA_DIR, hash + '.webp');
  if (fs.existsSync(outPath)) return '/media/' + hash + '.webp'; // 이미 캐시됨

  return new Promise((resolve, reject) => {
    const profile = USER_PROFILES[Math.floor(Math.random() * USER_PROFILES.length)];
    const headers = { 'User-Agent': profile.ua, 'Referer': referer || SOURCE + '/' };
    const urlObj = new URL(url);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers };
    https.get(options, (res) => {
      // 리다이렉트 처리
      if (res.statusCode === 301 || res.statusCode === 302) {
        cacheImage(res.headers.location, referer).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          await sharp(buf)
            .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 60 })
            .toFile(outPath);
          resolve('/media/' + hash + '.webp');
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}


// ── 통신 및 차단 회피 ───────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/119.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0"
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchText(url, referer = "", retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const options = {
        method: "GET",
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "max-age=0",
          "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        }
      };
      if (referer) {
        options.headers["Referer"] = referer;
        options.headers["Sec-Fetch-Site"] = "same-origin";
      }

      const res = await fetch(url, options);

      if (res.status === 429) {
        if (!isIpThrottled) {
          isIpThrottled = true;
          sendAlert(`🔴 IP 차단(429) 감지됨! 수집을 일시 중단합니다. URL: ${url}`);
        }
        throw new Error("IP_THROTTLED");
      }

      // 🚨 삭제 감지 로직 이식: 리다이렉트된 URL이 derror/deleted를 포함하는지 확인
      if (res.url.includes("derror/deleted")) throw new Error("DELETED_ORIGIN");
      if (res.status === 404) throw new Error("404");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return await res.text();
    } catch (e) {
      if (e.message === "DELETED_ORIGIN" || e.message === "404" || i === retries - 1) throw e;
      const wait = 1000 * Math.pow(2, i);
      console.log(`[Retry] ${url.substring(0, 50)}... 실패 (${e.message}). ${wait}ms 후 재시도... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

const USER_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: '"Windows"', ua_ver: '"Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"', mobile: '?0'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
    platform: '"Windows"', ua_ver: '"Edge";v="123", "Chromium";v="123", "Not-A.Brand";v="99"', mobile: '?0'
  }
];

let isIpThrottled = false;
function fetchTextHead(url, referer = "") {
  return new Promise((resolve, reject) => {
    if (isIpThrottled) return reject(new Error("IP_THROTTLED"));
    const profile = USER_PROFILES[Math.floor(Math.random() * USER_PROFILES.length)];
    const headers = { 'User-Agent': profile.ua, 'Referer': referer || SOURCE + '/' };
    const req = https.get(url, { headers, timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
        // 글 번호 패턴(data-no="숫자")이 발견되면 즉시 연결 중단 (초경량)
        if (data.includes('data-no="')) {
          req.destroy();
          resolve(data);
        }
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", (e) => resolve("")); // Abort 시 에러는 무시
  });
}


async function postJson(url, body, extraHeaders = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const p = urlLib.parse(url);
        const postData = new URLSearchParams(body).toString();
        const client = url.startsWith("https") ? https : http;
        const req = client.request({
          hostname: p.hostname, path: p.path, method: "POST",
          headers: Object.assign({}, { "User-Agent": USER_PROFILES[0].ua }, { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }, extraHeaders),
          timeout: 10000
        }, (res) => {
          if (res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 429) return reject(new Error("SERVER_ERR_" + res.statusCode));
          let data = ""; res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        });
        req.on("error", reject); req.write(postData); req.end();
      });
    } catch (e) {
      if (i === retries - 1) throw e;
      const wait = 1000 * Math.pow(2, i);
      console.log(`[Retry] ${url} (POST) 실패. ${wait}ms 후 재시도... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}



// ── 파서 ───────────────────────────────────────────────────
function firstMatch(html, res) { for (const re of res) { const m = html.match(re); if (m) return m[1]; } return ""; }
function extractImageUrls(html, baseUrl) {
  const urls = []; const re = /<img[^>]*src="([^"]+)"/gi; let m;
  while ((m = re.exec(html))) {
    const u = m[1]; if (u.indexOf("dcimg") >= 0 || u.indexOf("dcinside.com/viewimage.php") >= 0) urls.push(u.startsWith("http") ? u : urlLib.resolve(baseUrl, u));
  }
  return urls;
}

function parseList(html) {
  const rows = []; const pages = []; const pageRe = /&page=(\d+)/g; let pm;
  while ((pm = pageRe.exec(html))) { const p = parseInt(pm[1]); if (pages.indexOf(p) === -1) pages.push(p); }
  pages.sort((a, b) => a - b);

  // 특정 tbody에 국한되지 않고 전체 HTML에서 모든 행(tr)을 추출
  const trs = html.split(/<tr[^>]*>/i);

  for (let i = 1; i < trs.length; i++) {
    const b = trs[i].split(/<\/tr>/i)[0]; if (!b) continue;

    // 칸별 정밀 추출 함수
    const getCell = (cls) => {
      const m = b.match(new RegExp(`<td[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</td>`, "i"));
      return m ? m[1] : "";
    };

    const titCell = getCell("gall_tit");
    const writerCell = getCell("gall_writer");
    const dateCell = getCell("gall_date");
    const countCell = getCell("gall_count");
    const recommendCell = getCell("gall_recommend");

    // 1 & 2. 제목 및 링크 추출 (번호 포함)
    // 반드시 no=숫자가 포함된 진짜 글 링크에서 번호를 추출하여 정확도를 높입니다.
    const titM = titCell.match(/href="([^"]+id=vr[^"]+no=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titM) continue;

    const no = titM[2];
    const href = titM[1];
    if (!no || rows.find(r => r.no === no)) continue;

    let title = decodeEntities(stripTags(titM[3].replace(/<span[^>]*class="reply_num"[^>]*>[\s\S]*?<\/span>/gi, ""))).trim();
    if (title.length > 100) title = title.split("\n")[0].substring(0, 100).trim();

    // 3. 댓글 수 추출 (태그 내부 혹은 [숫자] 형태 모두 지원)
    const repM = b.match(/<span[^>]*class="reply_num"[^>]*>\[?(\d+)\]?<\/span>/i) ||
      titCell.match(/\[(\d+)\]/) ||
      b.match(/\[(\d+)\]/);
    const commentCount = repM ? repM[1] : "0";

    // 4. 작성자 및 아이콘 정밀 추출
    const nickM = b.match(/data-nick="([^"]*)"/i) ||
      writerCell.match(/class="nickname"[^>]*>([\s\S]*?)<\/span>/i);
    const ipM = b.match(/data-ip="([^"]*)"/i) || writerCell.match(/class="ip">([^<]*)<\/span>/i);

    let author = "";
    if (nickM) {
      author = decodeEntities(stripTags(nickM[1])).trim();
    } else {
      author = decodeEntities(stripTags(writerCell)).split("\n")[0].trim();
    }
    if (!author || author.length > 20) author = "ㅇㅇ";

    // 아이피 정보가 있으면 닉네임 뒤에 추가
    if (ipM && ipM[1] && ipM[1].trim()) {
      const ip = ipM[1].replace(/[()]/g, "").trim();
      if (ip) author += `(${ip})`;
    }

    // 유저 아이콘 추출 (긴 이름부터 체크하여 오인식 방지: 파딱 > 주딱 > 고닉 > 반고닉)
    let authorIcon = "";
    if (writerCell.includes("sub_managernik.gif")) authorIcon = "m";
    else if (writerCell.includes("managernik.gif")) authorIcon = "g";
    else if (writerCell.includes("fix_nik.gif")) authorIcon = "f";
    else if (writerCell.includes("nik.gif")) authorIcon = "s";
    else if (writerCell.includes("usericon g")) authorIcon = "g";
    else if (writerCell.includes("usericon m")) authorIcon = "m";
    else if (writerCell.includes("usericon f")) authorIcon = "f";
    else if (writerCell.includes("usericon s")) authorIcon = "s";

    // 5. 기타 메타데이터
    let date = decodeEntities(stripTags(dateCell)).trim();
    // 오늘 날짜면 시간만 표시 (선택사항, 원본 사이트 느낌)
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    if (date.includes(todayStr)) {
      const timePart = date.match(/\d{2}:\d{2}/);
      if (timePart) date = timePart[0];
    }
    const views = decodeEntities(stripTags(countCell)).replace(/,/g, "").trim() || "0";
    const likes = decodeEntities(stripTags(recommendCell || b.match(/class="gall_recommend"[^>]*>([\s\S]*?)<\/td>/i))).replace(/,/g, "").trim() || "0";

    const isNotice = /icon_notice|notice/i.test(b);
    const isBest = /class="[^"]*(?:icon_recomimg|icon_best|gall_best)[^"]*"/i.test(b);

    rows.push({
      no, type: isNotice ? "notice" : isBest ? "best" : "normal",
      deleted: false, category: "일반",
      title: title || "제목 없음", author: author || "ㅇㅇ",
      authorIcon,
      commentCount, date, views, likes,
      href: urlLib.resolve(SOURCE, href),
    });
  }
  return { items: rows, pages, firstPage: pages[0] || 1, lastPage: pages[pages.length - 1] || 1 };
}

function parsePost(html, url) {
  const title = decodeEntities(stripTags(firstMatch(html, [
    /class="title_subject"[^>]*>([\s\S]*?)<\/span>/i,
    /<span class="title_subject">([\s\S]*?)<\/span>/i,
    /<h2[^>]*>([\s\S]*?)<\/h2>/i
  ])));

  // 작성자 추출: data-nick 속성, nickname 클래스, 혹은 gall_writer 내부의 텍스트 탐색
  const authorMatch = html.match(/data-nick="([^"]*)"/i) ||
    html.match(/class="nickname"[^>]*>([\s\S]*?)<\/span>/i) ||
    html.match(/<em[^>]*>([\s\S]*?)<\/em>/i);
  let author = authorMatch ? decodeEntities(stripTags(authorMatch[1])).trim() : "";

  // 작성자 영역 섹션 추출 (아이콘 오인식 방지)
  const writerSectionM = html.match(/<div class="writer_info[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<div class="gall_writer[^>]*>([\s\S]*?)<\/div>/i);
  const writerSection = writerSectionM ? writerSectionM[1] : html;

  const ipMatch = writerSection.match(/class="ip">([^<]*)<\/span>/i);
  if (ipMatch && ipMatch[1] && ipMatch[1].trim()) {
    const ip = ipMatch[1].replace(/[()]/g, "").trim();
    if (ip) author += `(${ip})`;
  }

  let authorIcon = "";
  if (writerSection.includes("sub_managernik.gif")) authorIcon = "m";
  else if (writerSection.includes("managernik.gif")) authorIcon = "g";
  else if (writerSection.includes("fix_nik.gif")) authorIcon = "f";
  else if (writerSection.includes("nik.gif")) authorIcon = "s";
  else if (writerSection.includes("usericon g")) authorIcon = "g";
  else if (writerSection.includes("usericon m")) authorIcon = "m";
  else if (writerSection.includes("usericon f")) authorIcon = "f";
  else if (writerSection.includes("usericon s")) authorIcon = "s";
  const date = firstMatch(html, [/<span class="gall_date" title="([^"]*)">/i, /<span class="gall_date">([^<]*)<\/span>/i]);
  const views = (html.match(/class="gall_count">.*?([0-9,]+)/i) || [null, ""])[1].replace(/,/g, "") || "0";
  const likes = (html.match(/class="gall_reply_num">.*?([0-9,]+)/i) || [null, ""])[1].replace(/,/g, "") || "0";
  const commentCount = (html.match(/class="gall_comment">.*?([0-9,]+)/i) || [null, ""])[1].replace(/,/g, "") || "0";
  // 본문 추출 고도화: 중첩된 div 구조에서도 끝까지 긁어오도록 개선
  let bodyH = "";
  const patterns = [
    // 1. write_div나 writing_view_box를 찾되, 뒤에 스크립트나 특정 경계가 나올 때까지 최대한 긁음
    /<div[^>]*class="[^"]*(?:write_div|writing_view_box)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div class="comm_modi"|<!--|$)/i,
    // 2. 만약 위에서 실패하면 가장 바깥쪽 div 상자만이라도 확보
    /<div[^>]*class="write_div"[\s\S]*?>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="writing_view_box"[\s\S]*?>([\s\S]*?)<\/div>/i
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].trim().length > 0) {
      bodyH = m[1];
      break;
    }
  }

  // 🚨 영상 태그(iframe, embed) 추출 및 보존
  const images = extractImageUrls(bodyH || html, url);
  const rawText = decodeEntities(stripTags(bodyH)).trim();
  const eSnO = firstMatch(html, [/id="e_s_n_o"[^>]*value="([^"]*)"/i, /name="e_s_n_o"[^>]*value="([^"]*)"/i]);
  const boardType = firstMatch(html, [/id="board_type"[^>]*value="([^"]*)"/i, /name="board_type"[^>]*value="([^"]*)"/i]);
  const gallType = firstMatch(html, [/id="_GALLTYPE_"[^>]*value="([^"]*)"/i, /name="_GALLTYPE_"[^>]*value="([^"]*)"/i]);
  // 데이터 검증: 제목이 유효하고 본문이나 이미지가 하나라도 있으면 통과
  const finalTitle = title || "제목 없음";
  const isValid = (finalTitle !== "상세 페이지" && finalTitle !== "제목 없음") && (rawText.length > 0 || images.length > 0 || bodyH.length > 0);

  return {
    url, title: finalTitle, author, authorIcon, date, views, likes, commentCount,
    rawText, bodyHtml: bodyH, images,
    comments: [], eSnO, boardType, gallType,
    _isValid: isValid
  };
}

function buildDcUrl(no, page) { return `${SOURCE}/mgallery/board/view/?id=vr&no=${no}&page=${page || 1}`; }

async function fetchComments(no, page, token, prevComments = []) {
  const newComments = []; let cp = 1;
  try {
    while (cp <= 10) {
      const data = await postJson(`${SOURCE}/board/comment/`, { id: "vr", no, cmt_id: "vr", cmt_no: no, e_s_n_o: token.eSnO || "", comment_page: cp, sort: "R", board_type: token.boardType || "", _GALLTYPE_: token.gallType || "M" }, { referer: buildDcUrl(no, page) });
      if (!data || !data.comments) break;
      const filteredBatch = data.comments
        .map(c => ({ name: c.name || "익명", meta: c.reg_date || "", body: decodeEntities(stripTags(c.memo || "")), depth: Number(c.depth || 0) }))
        .filter(c => c.name.trim() !== "댓글돌이");
      newComments.push(...filteredBatch);
      if (newComments.length >= Number(data.total_cnt || 0)) break;
      cp++;
    }
  } catch (e) { logError(e, "FetchComments"); }

  // [댓글 보존 로직] 기존 댓글과 병합
  if (prevComments.length === 0) return newComments;

  const merged = [...prevComments];
  for (const nc of newComments) {
    // 작성자, 시간, 본문이 모두 일치하는 댓글이 있는지 확인
    const exists = prevComments.some(pc => pc.name === nc.name && pc.meta === nc.meta && pc.body === nc.body);
    if (!exists) {
      merged.push(nc);
    }
  }

  // 시간순 정렬 (meta 기준)
  return merged.sort((a, b) => {
    const da = new Date(a.meta.replace(/\./g, '/'));
    const db = new Date(b.meta.replace(/\./g, '/'));
    return da - db;
  });
}

async function mergeCacheFromList(page, list) {
  for (const item of list.items) {
    const prev = await dbMgr.getPost(item.no);
    let finalType = item.type;
    if (prev && prev.type === "best") finalType = "best";

    const merged = Object.assign({}, prev || {}, item, {
      type: finalType,
      deleted: false, // 목록에 나타났으므로 삭제 안됨
      archivedAt: (prev && prev.archivedAt) || Date.now(),
      updatedAt: Date.now()
    });
    await dbMgr.savePost(merged);
  }
}

function send(res, code, body, type = "text/plain") {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

async function handleApi(parsed, res) {
  if (parsed.pathname === "/api/watch-toggle") {
    const no = parsed.query.no;
    if (!no) return send(res, 400, JSON.stringify({ success: false }), "application/json");

    const index = WATCH_LIST.indexOf(no);
    let isWatching = false;
    if (index > -1) {
      WATCH_LIST.splice(index, 1);
    } else {
      WATCH_LIST.push(no);
      isWatching = true;
    }
    saveWatchList();
    send(res, 200, JSON.stringify({ success: true, isWatching }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/watch-status") {
    const no = parsed.query.no;
    const isWatching = WATCH_LIST.includes(no);
    send(res, 200, JSON.stringify({ isWatching }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/refresh-post") {
    const no = parseInt(parsed.query.no);
    if (!no) return send(res, 400, JSON.stringify({ success: false, error: "no is required" }), "application/json");
    try {
      // processItem을 강제로 호출하여 데이터 갱신
      await processItem({ no, href: buildDcUrl(no, 1) });
      send(res, 200, JSON.stringify({ success: true }), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ success: false, error: e.message }), "application/json");
    }
    return true;
  }
  if (parsed.pathname === "/api/refresh") {
    const mode = parsed.query.mode || "all";
    if (mode === "best" || mode === "all") if (!isRefreshingBest) refreshBestPosts().catch(() => { });
    if (mode === "crawl" || mode === "all") if (!isCrawling) backgroundCrawl().catch(() => { });
    if (mode === "pages") {
      const count = Math.min(Number(parsed.query.count || 5), 100);
      backgroundCrawl(count).catch(() => { });
    }
    send(res, 200, JSON.stringify({ ok: true }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/stats") {
    try {
      const stats = await dbMgr.get("SELECT COUNT(*) as total, SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) as deleted FROM posts");
      const cmtStats = await dbMgr.get("SELECT COUNT(DISTINCT postNo) as cnt FROM comments");

      let totalSize = 0;
      let lastHourSize = 0;
      let lastDaySize = 0;
      const now = Date.now();

      if (fs.existsSync(MEDIA_DIR)) {
        const files = fs.readdirSync(MEDIA_DIR);
        for (const file of files) {
          try {
            const fstat = fs.statSync(path.join(MEDIA_DIR, file));
            totalSize += fstat.size;
            if (now - fstat.mtimeMs < 1000 * 60 * 60) lastHourSize += fstat.size;
            if (now - fstat.mtimeMs < 1000 * 60 * 60 * 24) lastDaySize += fstat.size;
          } catch (e) { }
        }
      }

      send(res, 200, JSON.stringify({
        posts: stats.total,
        deleted: stats.deleted,
        comments: cmtStats.cnt,
        storage: {
          total: (totalSize / 1024 / 1024).toFixed(2) + " MB",
          lastHour: (lastHourSize / 1024 / 1024).toFixed(2) + " MB",
          lastDay: (lastDaySize / 1024 / 1024).toFixed(2) + " MB",
          estimatedMonth: ((lastDaySize * 30) / 1024 / 1024).toFixed(2) + " MB"
        }
      }), "application/json");
    } catch (e) { send(res, 500, e.message); }
    return true;
  }
  if (parsed.pathname === "/api/list") {
    const page = parsed.query.page || "1";
    const mode = parsed.query.mode || "all";
    const q = (parsed.query.q || "").toLowerCase();
    const sm = parsed.query.sm || "all";

    try {
      // 1페이지일 때는 실시간 동기화 병행
      if (page === "1" && !q && mode === "all") {
        const html = await fetchText(`${SOURCE}/mgallery/board/lists/?id=vr&page=1`, SOURCE + '/');
        const list = parseList(html);
        await mergeCacheFromList(1, list);
      }

      const result = await dbMgr.getList({ mode, page, q, sm });
      send(res, 200, JSON.stringify({ items: result.items, lastPage: result.lastPage }), "application/json");
    } catch (e) { logError(e, "ApiList"); send(res, 500, e.message); }
    return true;
  }
  if (parsed.pathname === "/api/post") {
    const no = parsed.query.no;
    try {
      const prev = await dbMgr.getPost(no);
      // 만약 DB에 없거나 업데이트가 필요하면 실시간 수집
      if (!prev || !prev.rawText || (Date.now() - (prev.updatedAt || 0) > 10 * 60 * 1000)) {
        const url = buildDcUrl(no, parsed.query.page);
        const html = await fetchText(url, SOURCE + '/');
        const post = parsePost(html, url);
        post.comments = await fetchComments(no, parsed.query.page, post, (prev && prev.comments) || []);

        let localImages = (prev && prev.localImages) || [];
        if (post.images && post.images.length > 0 && localImages.length === 0) {
          const cached = [];
          for (const img of post.images) {
            try { const p = await cacheImage(img, url); if (p) cached.push(p); } catch (e) { }
          }
          localImages = cached;
        }

        const merged = Object.assign({}, prev || {}, post, {
          archivedAt: (prev && prev.archivedAt) || Date.now(),
          updatedAt: Date.now(),
          localImages
        });
        await dbMgr.savePost(merged);
        send(res, 200, JSON.stringify(merged), "application/json");
      } else {
        send(res, 200, JSON.stringify(prev), "application/json");
      }
    } catch (e) {
      const post = await dbMgr.getPost(no);
      send(res, 200, JSON.stringify(post || { deleted: true }), "application/json");
    }
    return true;
  }


  if (parsed.pathname === "/api/image-debug") {
    const no = parsed.query.no;
    const cached = no ? await dbMgr.getPost(no) : null;
    const mediaFiles = fs.readdirSync(MEDIA_DIR).length;

    if (!no) {
      send(res, 200, JSON.stringify({ mediaFileCount: mediaFiles, info: "no parameter required" }, null, 2), "application/json");
      return true;
    }

    send(res, 200, JSON.stringify({
      no,
      title: cached?.title,
      author: cached?.author,
      rawImages: cached?.images || [],
      localImages: cached?.localImages || [],
      mediaFileCount: mediaFiles
    }, null, 2), "application/json");
    return true;
  }


  if (parsed.pathname === "/api/debug") {
    const total = await dbMgr.get("SELECT COUNT(*) as cnt FROM posts");
    const withCmt = await dbMgr.get("SELECT COUNT(DISTINCT postNo) as cnt FROM comments");
    send(res, 200, JSON.stringify({ totalPosts: total.cnt, postsWithComments: withCmt.cnt }, null, 2), "application/json");
    return true;
  }
  return false;
}


const WATCH_LIST_FILE = "watch-list.json";
let WATCH_LIST = [];

function loadWatchList() {
  if (fs.existsSync(WATCH_LIST_FILE)) {
    try { WATCH_LIST = JSON.parse(fs.readFileSync(WATCH_LIST_FILE, "utf-8")); } catch (e) { }
  }
  if (!Array.isArray(WATCH_LIST)) WATCH_LIST = [];
}
function saveWatchList() {
  try { fs.writeFileSync(WATCH_LIST_FILE, JSON.stringify(WATCH_LIST, null, 2), "utf-8"); } catch (e) { }
}
loadWatchList();

// 5초마다 임시 파일(add-watch.bat에서 생성) 확인하여 감시 목록 추가
setInterval(() => {
  const tmpFile = path.join(__dirname, "watch-list.tmp");
  if (fs.existsSync(tmpFile)) {
    try {
      const content = fs.readFileSync(tmpFile, "utf-8").trim();
      const lines = content.split(/\r?\n/);
      let added = false;
      for (let no of lines) {
        no = no.trim();
        if (no && /^\d+$/.test(no) && !WATCH_LIST.includes(no)) {
          WATCH_LIST.push(no);
          added = true;
          console.log(`[Watchdog] 새 감시 대상 추가: ${no}`);
          processItem({ no, href: buildDcUrl(no, 1), type: 'notice' }, SOURCE + '/').catch(() => { });
        }
      }
      if (added) saveWatchList();
      fs.unlinkSync(tmpFile);
    } catch (e) { }
  }
}, 5000);

async function shouldProcess(item) {
  const cached = await dbMgr.getPost(item.no);
  if (!cached || !cached.archivedAt) return true;

  const now = Date.now();
  const lastUpdate = cached.updatedAt || cached.archivedAt || 0;

  // 1. 고정 감시 대상 (WATCH_LIST)
  const isPriority = WATCH_LIST.includes(String(item.no));
  if (isPriority) {
    if (now - lastUpdate > 2 * 60 * 1000) return true;
  }

  // 2. 메타데이터 변경 감지
  const dcCommentCount = Number(item.commentCount || 0);
  const archivedCommentCount = (cached.comments || []).length;

  if (dcCommentCount > archivedCommentCount || item.title !== cached.title || item.type !== cached.type) {
    return true;
  }

  // 3. 일반 글은 15분마다 갱신
  if (now - lastUpdate > 15 * 60 * 1000) return true;

  return false;
}
async function processItem(item, referer = SOURCE + '/') {
  const no = item.no;
  try {
    const html = await fetchText(item.href, referer);

    // 🚨 본문 키워드 기반 삭제 감지 (리다이렉트되지 않은 경우)
    if (html.includes("삭제된 게시글입니다") || html.includes("존재하지 않는 게시물입니다") || html.includes("잘못된 접근입니다")) {
      const prev = await dbMgr.getPost(no);
      await dbMgr.savePost(Object.assign({}, prev || {}, item, {
        category: '삭제글', deleted: 1, updatedAt: Date.now(), archivedAt: (prev && prev.archivedAt) || Date.now()
      }));
      console.log(`[Cleaner] ${no}번 글 삭제 확인 (키워드)`);
      return;
    }

    const post = parsePost(html, item.href);
    if (!post._isValid) return;

    // 🚨 HTML 레이아웃 보존: 원본 HTML을 정화하고 이미지 경로를 로컬로 치환
    let contentHtml = post.bodyHtml || "";

    // 영상 태그(iframe, embed)를 작은 아이콘 박스로 치환
    const videoPlaceholder = `<a href="${item.href}" target="_blank" class="video-placeholder" title="원본 글에서 영상 보기" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px; padding:6px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; color:#475467; font-size:12px; margin:8px 0; user-select:none;">
      <span style="font-size:16px;">📹</span>
      <strong style="color:#475467;">원본 사이트 영상 (클릭하여 보기)</strong>
    </a>`;
    contentHtml = contentHtml.replace(/<(?:iframe|embed)[\s\S]*?<\/(?:iframe|embed)>|<(?:iframe|embed)[\s\S]*?>/gi, videoPlaceholder);

    // 불필요한 태그 제거 (스크립트 등)
    contentHtml = contentHtml.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/on\w+="[^"]*"/gi, "");

    const prev = await dbMgr.getPost(no);
    post.comments = await fetchComments(no, item.page || 1, post, (prev && prev.comments) || []);

    const merged = Object.assign({}, prev || {}, post, {
      archivedAt: (prev && prev.archivedAt) || Date.now(),
      updatedAt: Date.now()
    });

    // 이미지 로컬 캐싱 및 HTML 내 경로 치환
    if (post.images && post.images.length > 0) {
      const localImages = (prev && prev.localImages) || [];
      const cached = [];

      // 이미지가 새로 수집되는 경우 혹은 기존에 이미지가 없는 경우만 캐싱 수행
      if (localImages.length === 0) {
        for (const img of post.images) {
          try {
            const localPath = await cacheImage(img, item.href);
            if (localPath) cached.push(localPath);
            else cached.push("");
          } catch (e) { cached.push(""); }
        }
        merged.localImages = cached;
      } else {
        cached.push(...localImages);
      }

      // HTML 내의 원본 이미지 주소를 로컬 주소로 치환
      post.images.forEach((img, idx) => {
        if (cached[idx]) {
          const escapedImg = img.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          contentHtml = contentHtml.replace(new RegExp(escapedImg, 'g'), cached[idx]);
        }
      });
    }

    merged.contentHtml = contentHtml;
    await dbMgr.savePost(merged);
    console.log(`[Archive] 글 ${no} (${post.title}) 수집 완료 (레이아웃 보존됨)`);

  } catch (e) {
    if (e.message === "DELETED_ORIGIN" || e.message === "404") {
      const prev = await dbMgr.getPost(no);
      await dbMgr.savePost(Object.assign({}, prev || {}, item, {
        category: '삭제글', deleted: 1, updatedAt: Date.now(), archivedAt: (prev && prev.archivedAt) || Date.now()
      }));
      console.log(`[Cleaner] ${no}번 글 삭제 확인 (${e.message})`);
      return;
    }
    console.error(`[Error] 글 ${item.no} 수집 실패:`, e.message);
  }
}


let isCrawling = false;
async function backgroundCrawl(targetPages) {
  const pCount = targetPages || CRAWL_PAGES;
  const isManual = !!targetPages;

  // 자동 크롤링일 때만 중복 실행 방지, 수동(isManual)은 무조건 실행
  if (!isManual && isCrawling) return;

  isCrawling = true;
  try {
    for (let bp = 1; bp <= 1; bp++) { // 퀵싱크는 1페이지만 빠르게
      const html = await fetchText(`${SOURCE}/mgallery/board/lists/?id=vr&page=${bp}&exception_mode=recommend`, SOURCE + '/');
      const list = parseList(html);
      for (const item of list.items) {
        const prev = await dbMgr.getPost(item.no);
        if (prev && prev.type !== "best") {
          await dbMgr.run(`UPDATE posts SET type = 'best' WHERE no = ?`, [item.no]);
        }
        item.type = "best";
      }
      const targets = [];
      for (const i of list.items) { if (await shouldProcess(i)) targets.push(i); }
      for (const t of targets) { await processItem(t); await jitterWait(isManual ? 300 : 1000, isManual ? 600 : 2000); }
    }
    for (let p = 1; p <= pCount; p++) {
      const listUrl = `${SOURCE}/mgallery/board/lists/?id=vr&page=${p}`;
      const html = await fetchText(listUrl, SOURCE + '/');
      const list = parseList(html); mergeCacheFromList(p, list);

      const targets = [];
      for (const i of list.items) { if ((p <= 3 || isManual) ? true : await shouldProcess(i)) targets.push(i); }
      for (const t of targets) {
        await processItem(t, listUrl);
        await jitterWait(isManual ? 500 : 2000, isManual ? 1000 : 5000);
      }
      // 페이지당 수집 후 5~10초간 '심호흡' (사람처럼 행동)
      if (!isManual) await jitterWait(5000, 10000);
    }
  } finally { isCrawling = false; }
}
let isRefreshingBest = false;
async function refreshBestPosts() {
  if (isRefreshingBest || isCrawling) return; isRefreshingBest = true;
  try {
    const watchIds = WATCH_LIST.length > 0 ? WATCH_LIST.join(',') : '0';

    // 1. 화이트리스트 2. 개념글 3. 최신 150개 글을 통합하여 감시 대상으로 선정
    const targets = await dbMgr.query(`
      SELECT * FROM posts 
      WHERE (type = 'best' OR no IN (${watchIds}) OR no > (SELECT MAX(no) - 150 FROM posts))
      AND deleted = 0 
      ORDER BY no DESC 
      LIMIT ?
    `, [BEST_REFRESH_LIMIT]);

    for (const t of targets) { await processItem(t); await jitterWait(2000, 5000); }
  } finally { isRefreshingBest = false; }
}
const STARTUP_MAX_PAGES = 10;
async function startupCatchup() {
  const lastRow = await dbMgr.get(`SELECT MAX(no) as maxNo FROM posts WHERE archivedAt > 0`);
  const last = lastRow ? lastRow.maxNo : 0;
  if (last === 0) return backgroundCrawl();

  isCrawling = true; try {
    for (let p = 1; p <= STARTUP_MAX_PAGES; p++) {
      const html = await fetchText(`${SOURCE}/mgallery/board/lists/?id=vr&page=${p}`);
      const list = parseList(html); await mergeCacheFromList(p, list);

      const targets = [];
      for (const i of list.items) { if (p <= 3 ? true : await shouldProcess(i)) targets.push(i); }
      for (const t of targets) { await processItem(t); await jitterWait(2000, 5000); }

      const pMin = Math.min(...list.items.filter(i => i.type !== "notice").map(i => Number(i.no)));
      if (targets.length === 0 && pMin > 0 && pMin < last) break;
    }

    // 🚨 [추가] 최근 글 50개 삭제 여부 즉시 점검
    const recentPosts = await dbMgr.query(`SELECT * FROM posts WHERE deleted = 0 ORDER BY no DESC LIMIT 50`);
    console.log(`[System] 최근 글 ${recentPosts.length}개 상태 집중 점검 중...`);
    for (const t of recentPosts) {
      await processItem(t);
      // 점검은 수집보다 가벼우므로 0.5초 간격
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { isCrawling = false; }
}

// ── 최근 활성 글 정밀 삭제 감시 (Active Range Cleaner) ────────
const CLEANER_RANGE = 3000; // 최신 글 번호 기준 3000개 범위 집중 감시
let cleanerOffset = 0;

async function activeRangeCleaner() {
  if (isCrawling || isIpThrottled) return;
  try {
    const maxRow = await dbMgr.get(`SELECT MAX(no) as maxNo FROM posts`);
    const maxNo = maxRow ? maxRow.maxNo : 0;
    if (maxNo === 0) return;

    // 감시 범위 내의 글 중 5개를 가져와서 상태 확인
    const minNo = maxNo - CLEANER_RANGE;
    const targets = await dbMgr.query(
      `SELECT * FROM posts WHERE no > ? AND deleted = 0 ORDER BY updatedAt ASC LIMIT 5`,
      [minNo]
    );

    for (const t of targets) {
      // processItem이 내부적으로 fetchText를 통해 삭제를 감지함
      await processItem(t);
      await jitterWait(3000, 7000); // 디시 서버 배려를 위해 천천히
    }
  } catch (e) {
    console.error("[Cleaner] Active range scan failed:", e.message);
  }
}

// ── 초경량 번호 추적 스나이퍼 (Ultra-Light Sniper) ──────────────
let lastKnownMaxId = 0;
let sniperDelay = 5000; // 기본 5초

async function sniffer() {
  if (isCrawling || isIpThrottled) {
    setTimeout(sniffer, 5000);
    return;
  }

  try {
    // 1~2KB만 읽고 끊는 초경량 요청
    const html = await fetchTextHead(`${SOURCE}/mgallery/board/lists/?id=vr&page=1`, SOURCE + '/');
    const list = parseList(html);

    // 현재 목록 중 가장 큰 번호 추출
    const currentMax = Math.max(...list.items.map(i => Number(i.no) || 0));

    if (lastKnownMaxId === 0) {
      lastKnownMaxId = currentMax;
    } else if (currentMax > lastKnownMaxId) {
      const newItems = list.items.filter(i => Number(i.no) > lastKnownMaxId);
      console.log(`[Sniper] 새 글 ${newItems.length}개 발견! (MaxID: ${lastKnownMaxId} -> ${currentMax})`);

      lastKnownMaxId = currentMax;
      sniperDelay = 3000; // 새 글 발견 시 3초로 가속

      for (const item of newItems) {
        await processItem(item, `${SOURCE}/mgallery/board/lists/?id=vr&page=1`);
        await jitterWait(200, 500); // 박제를 위해 전광석화처럼 이동
      }
    } else {
      // 변화 없으면 주기를 서서히 15초까지 늘림
      sniperDelay = Math.min(sniperDelay + 2000, 15000);
    }
  } catch (e) {
    sniperDelay = 15000;
  }

  setTimeout(sniffer, sniperDelay);
}

startupCatchup().catch(() => { });
// 맥박 스나이퍼 가동
setTimeout(sniffer, 5000);

// 5분마다 전체 1페이지 동기화 (안전 수치로 조정)
setInterval(() => backgroundCrawl(1).catch(() => { }), 5 * 60 * 1000);
// 30분마다 전체 정밀 싱크
setInterval(() => backgroundCrawl(CRAWL_PAGES).catch(() => { }), 30 * 60 * 1000);
setTimeout(() => { refreshBestPosts(); setInterval(refreshBestPosts, 10 * 60 * 1000); }, 3 * 60 * 1000);

// ── 댓글 대량 복구 엔진 (가속 버전) ───────────────────────────
let isRecoveringComments = false;
async function commentRecoveryEngine() {
  if (isRecoveringComments || isIpThrottled) return;
  isRecoveringComments = true;
  try {
    const targets = await dbMgr.query(`
      SELECT p.* FROM posts p
      LEFT JOIN (SELECT postNo, COUNT(*) as cmt_cnt FROM comments GROUP BY postNo) c ON p.no = c.postNo
      WHERE p.deleted = 0 AND p.archivedAt > 0 
      AND p.commentCount > 0 
      AND (c.cmt_cnt IS NULL OR c.cmt_cnt = 0)
    `);
    if (targets.length === 0) return;
    // 글 번호(no) 기준 내림차순 정렬 → 최신 글부터 처리
    const batch = targets
      .sort((a, b) => parseInt(b.no, 10) - parseInt(a.no, 10))
      .slice(0, 20);
    console.log(`[Recovery] 누락 ${targets.length}개 / 최신 ${batch.length}개 처리 (${batch[0]?.no} ~ ${batch[batch.length - 1]?.no})`);

    for (const post of batch) {
      if (isIpThrottled) break;
      try {
        const targetUrl = post.href || buildDcUrl(post.no, 1);
        const html = await fetchText(targetUrl, SOURCE + '/');
        if (html.includes('삭제된 게시물') || html.includes('잘못된 접근')) {
          await dbMgr.run(`UPDATE posts SET deleted = 1 WHERE no = ?`, [post.no]);
        } else {
          const parsedPost = parsePost(html, post.href);
          const comments = await fetchComments(post.no, 1, parsedPost, post.comments || []);

          // 이미지도 함께 복구
          let localImages = post.localImages || [];
          if (parsedPost.images && parsedPost.images.length > 0 && localImages.length === 0) {
            const cached = [];
            for (const img of parsedPost.images) {
              try { const p = await cacheImage(img, post.href); if (p) cached.push(p); } catch (e) { }
            }
            localImages = cached;
          }

          const merged = Object.assign({}, post, {
            comments,
            localImages,
            updatedAt: Date.now()
          });
          await dbMgr.savePost(merged);
        }
        await jitterWait(1000, 2500);
      } catch (e) { /* 개별 실패 무시 */ }
    }
    const remainingRow = await dbMgr.get(`
      SELECT COUNT(*) as cnt FROM posts p
      LEFT JOIN (SELECT postNo, COUNT(*) as cmt_cnt FROM comments GROUP BY postNo) c ON p.no = c.postNo
      WHERE p.deleted = 0 AND p.commentCount > 0 AND (c.cmt_cnt IS NULL OR c.cmt_cnt = 0)
    `);
    console.log(`[Recovery] 배치 완료. 남은 누락: ${remainingRow.cnt}개`);
  } finally { isRecoveringComments = false; }
}
setTimeout(() => {
  commentRecoveryEngine().catch(() => { });
  setInterval(() => commentRecoveryEngine().catch(() => { }), 30 * 1000);
}, 10 * 1000);


http.createServer(async (req, res) => {
  const parsed = urlLib.parse(req.url, true);
  try {
    if (await handleApi(parsed, res)) return;
    if (parsed.pathname === "/" || parsed.pathname === "/index.html" || parsed.pathname === "/list/vr" || parsed.pathname.startsWith("/view/vr/")) {
      return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html; charset=utf-8");
    }
    if (parsed.pathname.startsWith("/media/")) {
      const f = path.join(MEDIA_DIR, path.basename(parsed.pathname));
      if (fs.existsSync(f)) {
        const ext = path.extname(f).toLowerCase();
        const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/avif';
        return send(res, 200, fs.readFileSync(f), mime);
      }
    }
    send(res, 404, "Not found");
  } catch (e) { send(res, 500, e.message); }
}).listen(PORT, async () => {
  const stats = await dbMgr.get("SELECT COUNT(*) as total, SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) as deleted FROM posts");
  const cmtStats = await dbMgr.get("SELECT COUNT(DISTINCT postNo) as cnt FROM comments");
  const mediaFiles = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).length : 0;

  console.log(`
  ##################################################
  #                                                #
  #   🚀 REAL-TIME IMAGE & COMMENT ARCHIVE v2.1    #
  #   (SQLite Engine Activated)                     #
  #                                                #
  #   📡 Server : http://localhost:${PORT}          #
  #   📦 Posts  : ${stats.total.toLocaleString()} items (${stats.deleted.toLocaleString()} deleted)
  #   💬 Cmt    : ${cmtStats.cnt.toLocaleString()} posts recovered
  #   🖼️ Media  : ${mediaFiles.toLocaleString()} files cached
  #                                                #
  ##################################################
  [System] ${new Date().toLocaleString()} 아카이브 엔진 가동 중...
  `);
});
