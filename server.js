require('dotenv').config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const urlLib = require("url");
const crypto = require("crypto");
const sharp = require("sharp");
const zlib = require("zlib");

// ── 설정 및 상수 ───────────────────────────────────────────
const PORT = process.env.PORT || 1557;
const SOURCE = "https://gall.dcinside.com";
const NOTIFICATION_URL = process.env.NOTIFICATION_URL;

// [갤러리 통합 설정] - 앞으로 여기에 추가만 하면 자동으로 확장됩니다.
const GALLERIES = {
  "vr": {
    id: "vr",
    name: "브이알챗",
    type: "mgallery",
    dbFile: "archive.db",
    color: "#3568d4"
  },
  "nevernesstoeverness": {
    id: "nevernesstoeverness",
    name: "네버네스 투 에버네스",
    type: "mgallery",
    dbFile: "archive_nte.db",
    color: "#8b5cf6"
  }
};

const GalleryDB = require("./db-manager");
const dbManagers = {};

async function initAllDatabases() {
  for (const key in GALLERIES) {
    const config = GALLERIES[key];
    dbManagers[key] = new GalleryDB(config.dbFile);
    await dbManagers[key].init();
    console.log(`[System] ${config.name} (${key}) DB 초기화 완료`);
  }
}

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
const MEDIA_DIR = path.join(__dirname, "media-cache");
const INDEX = path.join(__dirname, "index.html");
const ERROR_LOG = path.join(__dirname, "error.log");

// ── 성능 및 안정성 설정 ─────────────────────────────────────────
const BEST_REFRESH_LIMIT = 200;    // 주기적 '갱신' 최대 개수 (최신 글 감시 범위 포함)
const CRAWL_PAGES = 10;           // 기본 크롤링 페이지 수
const STARTUP_MAX_PAGES = 5;      // 시작 시 체크할 최대 페이지 수
sharp.cache(false);               // Sharp 메모리 캐시 비활성화 (메모리 누수 방지)
sharp.concurrency(1);             // 동시 처리 제한 (CPU/RAM 폭증 방지)

// ── 전역 에러 핸들러 (서버 다운 방지 및 기록) ──────────────────
function logError(err, type = "Error") {
  const msg = `[${new Date().toLocaleString()}] [${type}] ${err.stack || err}\n`;
  console.error(msg);
  try { fs.appendFileSync(ERROR_LOG, msg); } catch (e) { }
}
process.on('uncaughtException', (err) => logError(err, "UncaughtException"));
process.on('unhandledRejection', (reason) => logError(reason, "UnhandledRejection"));

// ── 디스코드 봇 (커맨드 센터) ──────────────────────────────
let discordClient = null;
if (DISCORD_TOKEN) {
  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    discordClient.on('ready', () => {
      console.log(`[Discord] 봇 로그인 성공: ${discordClient.user.tag}`);
      sendAlert("✅ 서버 및 디스코드 봇이 가동되었습니다.");
    });

    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || !msg.content.startsWith('!')) return;

      const args = msg.content.slice(1).split(' ');
      const command = args.shift().toLowerCase();
      const defaultGall = "vr";
      const dbMgr = dbManagers[defaultGall];
      if (!dbMgr) return;

      if (command === '상태') {
        const stats = await dbMgr.get("SELECT COUNT(*) as total, SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) as deleted FROM posts");
        msg.reply(`📊 **[${defaultGall}] 아카이브 현황**\n- 전체 게시글: ${stats.total}개\n- 삭제된 글: ${stats.deleted}개\n- IP 차단 상태: ${isIpThrottled ? '🔴 차단됨' : '🟢 정상'}`);
      }
      if (command === '감시' && args[0]) {
        const no = args[0];
        const watchList = WATCH_LISTS[defaultGall] || [];
        if (!watchList.includes(no)) {
          watchList.push(no); WATCH_LISTS[defaultGall] = watchList; saveWatchList(defaultGall);
          msg.reply(`⭐ [${defaultGall}] 글 번호 **${no}**를 감시 목록에 추가했습니다.`);
          processItem(dbMgr, defaultGall, { no, href: buildDcUrl(defaultGall, no, 1), type: 'notice' }, SOURCE + '/').catch(() => { });
        } else msg.reply(`이미 감시 중인 글입니다.`);
      }
      if (command === '갱신' && args[0]) {
        const no = args[0]; msg.reply(`🔄 **${no}** 수동 갱신 시작...`);
        await processItem(dbMgr, defaultGall, { no, href: buildDcUrl(defaultGall, no, 1), type: 'notice' }, SOURCE + '/');
        msg.reply(`✅ 갱신 완료!`);
      }
      if (command === '시작') { isIpThrottled = false; msg.reply(`🟢 수집 시작!`); }
      if (command === '중지') { isIpThrottled = true; msg.reply(`🛑 수집 중단!`); }
      if (command === 'ㄱㄷ' || command === '재시작') { await msg.reply(`🔄 재시작...`); process.exit(0); }
      if (command === '명령어' || command === 'help') {
        msg.reply(`🛠️ **명령어**: !상태, !감시 [번호], !갱신 [번호], !시작, !중지, !ㄱㄷ`);
      }
    });

    discordClient.login(DISCORD_TOKEN).catch(e => console.error("[Discord] 봇 로그인 실패:", e.message));
  } catch (e) { console.log("[Discord] 봇 기능 비활성화"); }
}

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

// ── 미디어 로컬 캐싱 (이미지 & 영상 통합) ──────────────────────────
async function cacheMedia(dbMgr, url, referer, force = false) {
  const urlHash = require('crypto').createHash('md5').update(url).digest('hex');
  // 기본적으로 .webp로 시도하지만, 이미 저장된 파일이 있으면 그 확장자를 따름
  let existingFile = null;
  const extensions = ['.webp', '.mp4', '.webm', '.gif', '.jpg', '.png'];
  for (const e of extensions) {
    if (fs.existsSync(path.join(MEDIA_DIR, urlHash + e))) {
      existingFile = urlHash + e;
      break;
    }
  }

  if (!force && existingFile) {
    const localUrlPath = '/media/' + existingFile;
    const existing = await dbMgr.get(`SELECT originalHash FROM images WHERE path = ? LIMIT 1`, [localUrlPath]);
    if (existing && existing.originalHash) return { path: localUrlPath, originalHash: existing.originalHash };
    try {
      const fileHash = crypto.createHash('md5').update(fs.readFileSync(path.join(MEDIA_DIR, existingFile))).digest('hex');
      return { path: localUrlPath, originalHash: fileHash };
    } catch (e) { return { path: localUrlPath, originalHash: '' }; }
  }

  return new Promise((resolve, reject) => {
    const profile = USER_PROFILES[Math.floor(Math.random() * USER_PROFILES.length)];
    const headers = { 'User-Agent': profile.ua, 'Referer': referer || SOURCE + '/' };
    const urlObj = new URL(url);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers };

    https.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        cacheMedia(dbMgr, res.headers.location, referer, force).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (buf.length < 100) return resolve(null);

          // 🚨 [용량 방어] 5MB가 넘어가는 '용량 폭탄'은 서버에 저장하지 않고 원본 링크 유지
          if (buf.length > 5 * 1024 * 1024) {
            console.log(`[Skip] 초대형 파일 제외 (${(buf.length / 1024 / 1024).toFixed(1)}MB): ${url}`);
            return resolve({ path: url, originalHash: crypto.createHash('md5').update(buf).digest('hex') });
          }

          const originalHash = crypto.createHash('md5').update(buf).digest('hex');

          if (await dbMgr.isBlacklisted(originalHash)) {
            resolve({ path: '', originalHash, isBlocked: true });
            return;
          }

          const dupPath = await dbMgr.getPathByHash(originalHash);
          if (dupPath && fs.existsSync(path.join(MEDIA_DIR, path.basename(dupPath)))) {
            resolve({ path: dupPath, originalHash });
            return;
          }

          // 이미지(GIF 포함)면 sharp로 최적화, 영상이면 그대로 저장
          // 실제 Content-Type에 따라 확장자 결정
          const contentType = res.headers['content-type'] || '';
          let ext = '.webp';
          if (contentType.includes('video/mp4')) ext = '.mp4';
          else if (contentType.includes('video/webm')) ext = '.webm';
          else if (contentType.includes('image/gif')) ext = '.gif';
          else if (contentType.includes('image/jpeg')) ext = '.jpg';
          else if (contentType.includes('image/png')) ext = '.png';

          const outPath = path.join(MEDIA_DIR, urlHash + ext);
          const localUrlPath = '/media/' + urlHash + ext;
          const isVideo = contentType.includes('video');

          if (isVideo) {
            fs.writeFileSync(outPath, buf);
            resolve({ path: localUrlPath, originalHash });
          } else {
            // 이미지 처리 (Sharp) - 애니메이션 WebP로 변환 저장
            try {
              const image = sharp(buf, { animated: true });
              const metadata = await image.metadata();
              const isAnimated = metadata.pages > 1;
              const finalPath = path.join(MEDIA_DIR, urlHash + '.webp');
              const finalUrl = '/media/' + urlHash + '.webp';

              await image
                .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 45, animated: isAnimated })
                .toFile(finalPath);
              resolve({ path: finalUrl, originalHash });
            } catch (err) {
              // 실패 시 원본 그대로 저장
              fs.writeFileSync(outPath, buf);
              resolve({ path: localUrlPath, originalHash });
            }
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
// 하위 호환성을 위해 이름 유지
const cacheImage = cacheMedia;


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
  const urls = new Set();
  // img 태그의 src, data-original, data-src 속성과 video 태그의 poster 등을 탐색합니다.
  const re = /<(?:img|video)[^>]*(?:src|data-original|data-src|poster)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    // 로딩용 임시 이미지는 건너뜁니다.
    if (u.includes("gallview_loading_ori.gif")) continue;

    if (u.includes("dcimg") || u.includes("dcinside.com/viewimage.php") || u.includes("dcinside.com/mgallery/board/view")) {
      // 엔티티가 섞여있을 수 있으므로 가급적 원본 형태 유지 (치환 시 매칭을 위해)
      urls.add(u.startsWith("http") ? u : urlLib.resolve(baseUrl, u));
    }
  }
  return Array.from(urls);
}

function parseList(html, gallId) {
  const rows = []; const pages = []; const pageRe = /&page=(\d+)/g; let pm;
  while ((pm = pageRe.exec(html))) { const p = parseInt(pm[1]); if (pages.indexOf(p) === -1) pages.push(p); }
  pages.sort((a, b) => a - b);

  // 1. 진짜 게시글(ub-content 클래스가 있는 tr)만 정확하게 추출
  const trs = html.match(/<tr[^>]*ub-content[\s\S]*?<\/tr>/gi) || [];

  for (let i = 0; i < trs.length; i++) {
    const b = trs[i];

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


    // 2. 제목 및 링크 추출 (번호 포함)
    const titM = titCell.match(new RegExp(`href="([^"]+id=${gallId}[^"]+no=(\\d+)[^"]*)"[^>]*>([\\s\\S]*?)<\\/a>`, "i"));
    if (!titM) continue;

    const noFromUrl = titM[2];
    const href = titM[1];

    const noCell = getCell("gall_num");
    const category = decodeEntities(stripTags(getCell("gall_subject") || "일반")).trim();
    const isNotice = noCell.includes("공지") || /icon_notice|notice/i.test(b) || category === "공지";

    // [보안 강화] 번호 칸(gall_num)의 숫자와 URL의 번호가 일치하는지 이중 확인
    const noFromCell = noCell.trim();
    const isNumericNo = /^\d+$/.test(noFromCell);

    // 번호가 일치하지 않거나 숫자가 아니면 (공지 제외) 무시
    if (!isNotice && (!isNumericNo || noFromCell !== noFromUrl)) continue;

    const no = isNotice ? noFromUrl : noFromCell;
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
    const uidM = b.match(/data-uid="([^"]*)"/i) || writerCell.match(/data-uid="([^"]*)"/i);

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

    const uid = uidM ? uidM[1].trim() : "";

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
    const views = decodeEntities(stripTags(countCell)).replace(/,/g, "").trim() || "0";
    const recommendVal = decodeEntities(stripTags(recommendCell || "")).replace(/,/g, "").trim() || "0";

    // 6. 타입 판별
    const isBest = /icon_recomimg|icon_best|gall_best/i.test(b) || (parseInt(recommendVal) >= 10);

    rows.push({
      no, type: isNotice ? "notice" : isBest ? "best" : "normal",
      deleted: false, category: category || (isNotice ? "공지" : "일반"),
      title: title || "제목 없음", author: author || "ㅇㅇ",
      authorIcon, uid,
      commentCount, date, views, likes: recommendVal,
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
  // data-uid 추출 (속성 형태와 텍스트 형태 모두 지원)
  const uidMatch = writerSection.match(/data-uid="([^"]*)"/i) || html.match(/data-uid="([^"]*)"/i);
  let uid = uidMatch ? uidMatch[1].trim() : "";

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
    // 핵심: write_div의 시작 태그(모든 속성 허용) ~ 하단 마커 사이를 통째로 캡처
    /<div[^>]+class="[^"]*write_div[^"]*"[^>]*>([\s\S]+?)(?=<div[^>]*class="comm_modi"|<div[^>]*class="report_btn"|<div[^>]*class="comment_wrap"|<div[^>]*class="all_reply"|<\/div>\s*<\/div>\s*<\/div>\s*<div[^>]*class="[^"]*view_bottom|<script\b)/i,
    // 백업 1: writing_view_box
    /<div[^>]+class="[^"]*writing_view_box[^"]*"[^>]*>([\s\S]+?)(?=<div[^>]*class="comm_modi"|<div[^>]*class="comment_wrap"|<script\b)/i,
    // 백업 2: gallery_view_contents
    /<div[^>]+class="[^"]*gallery_view_contents[^"]*"[^>]*>([\s\S]+?)(?=<div[^>]*class="comm_modi"|<div[^>]*class="comment_wrap"|<script\b)/i,
    // 최후 수단: write_div 시작 ~ 끝
    /<div[^>]+class="[^"]*write_div[^"]*"[^>]*>([\s\S]+)/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].trim().length > 0) {
      bodyH = m[1];
      break;
    }
  }

  // 디버그: 본문 추출 실패 시 원인 파악용 로그
  if (!bodyH || bodyH.trim().length === 0) {
    const snippet = html.substring(html.indexOf('<div class="'), html.indexOf('<div class="') + 500);
    console.log(`[Debug] 본문 추출 실패 - URL: ${url}\n  HTML 스니펫: ${snippet.replace(/\s+/g, ' ').substring(0, 300)}`);
  }

  // 🚨 영상 태그(iframe, embed) 추출 및 보존
  const images = extractImageUrls(bodyH || html, url);
  const rawText = decodeEntities(stripTags(bodyH)).trim();
  const eSnO = firstMatch(html, [/id="e_s_n_o"[^>]*value="([^"]*)"/i, /name="e_s_n_o"[^>]*value="([^"]*)"/i]);
  const boardType = firstMatch(html, [/id="board_type"[^>]*value="([^"]*)"/i, /name="board_type"[^>]*value="([^"]*)"/i]);
  const gallType = firstMatch(html, [/id="_GALLTYPE_"[^>]*value="([^"]*)"/i, /name="_GALLTYPE_"[^>]*value="([^"]*)"/i]);
  // 데이터 검증: 제목이 있거나 본문/이미지가 있으면 통과 (이미지 없는 텍스트 글도 수집)
  const finalTitle = title || "제목 없음";
  const hasContent = rawText.length > 0 || images.length > 0 || bodyH.length > 0;
  const hasTitle = finalTitle !== "상세 페이지";
  const isValid = hasTitle && hasContent;

  return {
    url, title: finalTitle, author, authorIcon, uid, date, views, likes, commentCount,
    rawText, bodyHtml: bodyH, images,
    comments: [], eSnO, boardType, gallType,
    _isValid: isValid
  };
}

function buildDcUrl(gallId, no, page) {
  const gall = GALLERIES[gallId] || GALLERIES["vr"];
  return `${SOURCE}/${gall.type}/board/view/?id=${gall.id}&no=${no}&page=${page || 1}`;
}

async function fetchComments(dbMgr, gallId, no, page, token, prevComments = []) {
  const newComments = []; let cp = 1;
  const gall = GALLERIES[gallId] || GALLERIES["vr"];
  try {
    while (cp <= 10) {
      const data = await postJson(`${SOURCE}/board/comment/`, { id: gall.id, no, cmt_id: gall.id, cmt_no: no, e_s_n_o: token.eSnO || "", comment_page: cp, sort: "R", board_type: token.boardType || "", _GALLTYPE_: token.gallType || "M" }, { referer: buildDcUrl(gallId, no, page) });
      if (!data || !data.comments) break;
      const filteredBatch = data.comments
        .map(c => {
          let author = c.name || "익명";
          if (c.ip) author += `(${c.ip})`;

          // [수정] 디시 API의 다양한 필드명에 대응 (user_id, id, no 등)
          const uid = c.user_id || c.id || "";

          // 아이콘 판별 고도화
          let icon = "";
          if (uid) {
            // 관리자 여부 확인 (G: 주딱, M: 파딱)
            if (c.is_manager === 'G' || c.member_icon === 'G') icon = 'g';
            else if (c.is_manager === 'M' || c.member_icon === 'M') icon = 'm';
            else icon = 's'; // 기본 고닉
          }

          return {
            name: author,
            uid: uid,
            icon: icon,
            meta: c.reg_date || "",
            body: decodeEntities(stripTags(c.memo || "")),
            depth: Number(c.depth || 0)
          };
        })
        .filter(c => c.name.trim() !== "댓글돌이");

      // 구조 파악을 위한 디버깅 로그 (필요 시 주석 해제)
      // if (data.comments.length > 0) console.log("[Debug Comment]", data.comments[0]);
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
    const ma = (a.meta || "").replace(/\./g, '/');
    const mb = (b.meta || "").replace(/\./g, '/');
    const da = ma ? new Date(ma) : new Date(0);
    const db = mb ? new Date(mb) : new Date(0);
    return da - db;
  });
}

async function mergeCacheFromList(dbMgr, gallId, page, list) {
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

function send(res, code, data, type = "text/plain") {
  if (res.writableEnded) return;

  let payload = data;
  let headers = {
    "Content-Type": type.includes("charset") ? type : type + "; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  };

  // 1KB 이상의 텍스트/JSON 데이터는 Gzip 압축 처리
  if (data && data.length > 1024 && (type.includes("text") || type.includes("json"))) {
    try {
      payload = zlib.gzipSync(Buffer.from(data));
      headers["Content-Encoding"] = "gzip";
    } catch (e) {
      payload = data;
    }
  }

  res.writeHead(code, headers);
  res.end(payload);
}

async function handleApi(parsed, res) {
  const gallId = parsed.query.gall || "vr";
  const dbMgr = dbManagers[gallId];
  if (!dbMgr) return send(res, 404, JSON.stringify({ error: "Invalid gallery ID" }), "application/json");

  if (parsed.pathname === "/api/toggle-crawler") {
    const enabled = parsed.query.enabled === "true";
    GALLERY_SETTINGS[gallId] = { ...GALLERY_SETTINGS[gallId], enabled };
    saveGallerySettings();
    send(res, 200, JSON.stringify({ success: true, enabled }), "application/json");
    return true;
  }

  if (parsed.pathname === "/api/watch-toggle") {
    const no = parsed.query.no;
    if (!no) return send(res, 400, JSON.stringify({ success: false }), "application/json");

    const watchList = WATCH_LISTS[gallId] || [];
    const index = watchList.indexOf(no);
    let isWatching = false;
    if (index > -1) {
      watchList.splice(index, 1);
    } else {
      watchList.push(no);
      isWatching = true;
    }
    WATCH_LISTS[gallId] = watchList;
    saveWatchList(gallId);
    send(res, 200, JSON.stringify({ success: true, isWatching }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/watch-status") {
    const no = parsed.query.no;
    const isWatching = (WATCH_LISTS[gallId] || []).includes(no);
    send(res, 200, JSON.stringify({ isWatching }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/refresh-post") {
    const no = parseInt(parsed.query.no);
    if (!no) return send(res, 400, JSON.stringify({ success: false, error: "no is required" }), "application/json");
    try {
      await processItem(dbMgr, gallId, { no, href: buildDcUrl(gallId, no, 1) });
      send(res, 200, JSON.stringify({ success: true }), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ success: false, error: e.message }), "application/json");
    }
    return true;
  }
  if (parsed.pathname === "/api/refresh") {
    const mode = parsed.query.mode || "all";
    if (mode === "best" || mode === "all") refreshBestPosts(dbMgr, gallId).catch(() => { });
    if (mode === "crawl" || mode === "all") backgroundCrawl(dbMgr, gallId, null, true).catch(() => { });
    if (mode === "pages") {
      const count = Math.min(Number(parsed.query.count || 5), 100);
      backgroundCrawl(dbMgr, gallId, count, true).catch(() => { });
    }
    send(res, 200, JSON.stringify({ ok: true }), "application/json");
    return true;
  }
  if (parsed.pathname === "/api/stats") {
    try {
      const stats = await dbMgr.get("SELECT COUNT(*) as total, SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) as deleted FROM posts");
      const cmtStats = await dbMgr.get("SELECT COUNT(DISTINCT postNo) as cnt FROM comments");

      let totalSize = 0;
      let lastDaySize = 0;
      const now = Date.now();
      const oneDayAgo = now - (24 * 60 * 60 * 1000);

      if (fs.existsSync(MEDIA_DIR)) {
        const files = fs.readdirSync(MEDIA_DIR);
        for (const file of files) {
          try {
            const fpath = path.join(MEDIA_DIR, file);
            const fstat = fs.statSync(fpath);
            totalSize += fstat.size;
            if (fstat.mtimeMs > oneDayAgo) {
              lastDaySize += fstat.size;
            }
          } catch (e) { }
        }
      }

      const lastDayMB = (lastDaySize / 1024 / 1024).toFixed(2);
      const estimatedMonthGB = ((lastDaySize * 30) / 1024 / 1024 / 1024).toFixed(2);

      send(res, 200, JSON.stringify({
        posts: stats.total,
        deleted: stats.deleted,
        comments: cmtStats.cnt,
        storage: {
          total: (totalSize / 1024 / 1024).toFixed(2) + " MB",
          lastDay: lastDayMB + " MB",
          estimatedMonth: estimatedMonthGB + " GB"
        }
      }), "application/json");
    } catch (e) { send(res, 500, e.message); }
    return true;
  }
  if (parsed.pathname === "/api/config") {
    const gall = GALLERIES[gallId];
    send(res, 200, JSON.stringify({
      gallId: gall.id,
      gallName: gall.name,
      gallType: gall.type,
      gallColor: gall.color || "#3568d4",
      crawlerEnabled: GALLERY_SETTINGS[gallId]?.enabled !== false,
      allGalleries: Object.values(GALLERIES).map(g => ({ id: g.id, name: g.name }))
    }), "application/json");
    return true;
  }

  if (parsed.pathname === "/api/list") {
    const page = parsed.query.page || "1";
    const mode = parsed.query.mode || "all";
    const q = (parsed.query.q || "").toLowerCase();
    const sm = parsed.query.sm || "all";

    try {
      if (page === "1" && !q && mode === "all") {
        const gall = GALLERIES[gallId];
        fetchText(`${SOURCE}/${gall.type}/board/lists/?id=${gall.id}&page=1`, SOURCE + '/').then(html => {
          const list = parseList(html, gallId);
          mergeCacheFromList(dbMgr, gallId, 1, list);
        }).catch(e => console.error("[Background Sync Error]", e.message));
      }

      const result = await dbMgr.getList({ mode, page, q, sm });
      send(res, 200, JSON.stringify({ items: result.items, lastPage: result.lastPage }), "application/json");
    } catch (e) { logError(e, "ApiList"); send(res, 500, e.message); }
    return true;
  }
  if (parsed.pathname === "/api/post") {
    const no = parsed.query.no;
    try {
      let post = await dbMgr.getPost(no);
      if (!post || (!post.rawText && !post.contentHtml) || (Date.now() - (post.updatedAt || 0) > 10 * 60 * 1000)) {
        const url = buildDcUrl(gallId, no, parsed.query.page);
        await processItem(dbMgr, gallId, { no, href: url, page: parsed.query.page || 1 }, SOURCE + '/');
        post = await dbMgr.getPost(no);
      }

      if (post) {
        post.href = post.href || buildDcUrl(gallId, post.no);
        send(res, 200, JSON.stringify(post), "application/json");
      } else {
        send(res, 200, JSON.stringify({ deleted: true }), "application/json");
      }
    } catch (e) {
      console.error("[ApiPost Error]", e.message);
      const post = await dbMgr.getPost(no);
      if (post) post.href = post.href || buildDcUrl(gallId, post.no);
      send(res, 200, JSON.stringify(post || { deleted: true }), "application/json");
    }
    return true;
  }

  if (parsed.pathname === "/api/purge-image") {
    const imgPath = parsed.query.path;
    if (!imgPath) return send(res, 400, JSON.stringify({ success: false, error: "path is required" }), "application/json");

    try {
      const info = await dbMgr.db.prepare(`SELECT originalHash FROM images WHERE path = ?`).get(imgPath);
      if (!info) return send(res, 404, JSON.stringify({ success: false, error: "Image not found in DB" }), "application/json");

      const targetHash = info.originalHash;
      if (targetHash) await dbMgr.blacklistImage(targetHash, "사용자 요청에 의한 말소");

      const allOccurrences = targetHash
        ? await dbMgr.db.prepare(`SELECT path FROM images WHERE originalHash = ?`).all(targetHash)
        : [{ path: imgPath }];

      let deletedCount = 0;
      for (const occurrence of allOccurrences) {
        const fullPath = path.join(MEDIA_DIR, path.basename(occurrence.path));
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          deletedCount++;
        }

        const imgTagRe = new RegExp(`<img[^>]+src=["']${occurrence.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'gi');
        const replacement = `<div style="padding:20px; background:#fee2e2; border:1px solid #ef4444; border-radius:8px; color:#b91c1c; font-size:12px; text-align:center; margin:10px 0;">관리자에 의해 영구 삭제된 이미지입니다.</div>`;

        const affectedPosts = await dbMgr.query(`SELECT no, contentHtml FROM posts WHERE contentHtml LIKE ?`, [`%${occurrence.path}%`]);
        for (const p of affectedPosts) {
          const newHtml = p.contentHtml.replace(imgTagRe, replacement);
          await dbMgr.run(`UPDATE posts SET contentHtml = ? WHERE no = ?`, [newHtml, p.no]);
        }
      }

      if (targetHash) {
        await dbMgr.db.prepare(`DELETE FROM images WHERE originalHash = ?`).run(targetHash);
      } else {
        await dbMgr.db.prepare(`DELETE FROM images WHERE path = ?`).run(imgPath);
      }

      send(res, 200, JSON.stringify({ success: true, deletedCount, hash: targetHash }), "application/json");
    } catch (e) {
      logError(e, "PurgeImage");
      send(res, 500, JSON.stringify({ success: false, error: e.message }), "application/json");
    }
    return true;
  }

  if (parsed.pathname === "/api/media-all") {
    const sort = parsed.query.sort || 'latest';
    const postNo = parsed.query.postNo;
    const hash = parsed.query.hash;
    const limit = 60;
    const offset = parseInt(parsed.query.offset || 0);

    try {
      let sql = `SELECT path, originalHash as hash, MAX(id) as lastId, COUNT(*) as refCount FROM images WHERE 1=1`;
      let params = [];
      if (postNo) { sql += ` AND postNo = ? `; params.push(postNo); }
      if (hash) { sql += ` AND originalHash = ? `; params.push(hash); }
      sql += ` GROUP BY originalHash `;
      sql += sort === 'popular' ? ` ORDER BY refCount DESC, lastId DESC ` : ` ORDER BY lastId DESC `;
      sql += ` LIMIT ? OFFSET ? `;
      params.push(limit, offset);

      const data = await dbMgr.query(sql, params);
      send(res, 200, JSON.stringify(data), "application/json");
    } catch (e) { send(res, 500, JSON.stringify({ error: e.message }), "application/json"); }
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

// 갤러리별 개별 감시 목록 파일 및 갱신 엔진
const getWatchListFile = (gallId) => `watch-list_${gallId}.json`;
const getGallerySettingsFile = () => `gallery-settings.json`;
const WATCH_LISTS = {};
let GALLERY_SETTINGS = {};

function loadWatchList(gallId) {
  const file = getWatchListFile(gallId);
  if (fs.existsSync(file)) {
    try { WATCH_LISTS[gallId] = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { }
  }
  if (!Array.isArray(WATCH_LISTS[gallId])) WATCH_LISTS[gallId] = [];
}
function saveWatchList(gallId) {
  try { fs.writeFileSync(getWatchListFile(gallId), JSON.stringify(WATCH_LISTS[gallId], null, 2), "utf-8"); } catch (e) { }
}

function loadGallerySettings() {
  const file = getGallerySettingsFile();
  if (fs.existsSync(file)) {
    try { GALLERY_SETTINGS = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { }
  }
  for (const id in GALLERIES) {
    if (!GALLERY_SETTINGS[id]) GALLERY_SETTINGS[id] = { enabled: true };
  }
}
function saveGallerySettings() {
  try { fs.writeFileSync(getGallerySettingsFile(), JSON.stringify(GALLERY_SETTINGS, null, 2), "utf-8"); } catch (e) { }
}

// 초기 로드
loadGallerySettings();
for (const id in GALLERIES) loadWatchList(id);

// 5초마다 임시 파일 확인 (레거시 대응: watch-list.tmp는 기본 갤러리 'vr'로 처리)
setInterval(() => {
  const tmpFile = path.join(__dirname, "watch-list.tmp");
  if (fs.existsSync(tmpFile)) {
    try {
      const content = fs.readFileSync(tmpFile, "utf-8").trim();
      const lines = content.split(/\r?\n/);
      let added = false;
      const gallId = "vr"; // 레거시 뱃지 파일은 vr로 고정
      const dbMgr = dbManagers[gallId];

      for (let no of lines) {
        no = no.trim();
        if (no && /^\d+$/.test(no) && !WATCH_LISTS[gallId].includes(no)) {
          WATCH_LISTS[gallId].push(no);
          added = true;
          console.log(`[Watchdog:${gallId}] 새 감시 대상 추가: ${no}`);
          processItem(dbMgr, gallId, { no, href: buildDcUrl(gallId, no, 1), type: 'notice' }, SOURCE + '/').catch(() => { });
        }
      }
      if (added) saveWatchList(gallId);
      fs.unlinkSync(tmpFile);
    } catch (e) { }
  }
}, 5000);

async function shouldProcess(dbMgr, gallId, item) {
  const cached = await dbMgr.getPost(item.no);
  if (!cached || !cached.archivedAt) return true;

  const now = Date.now();
  const lastUpdate = cached.updatedAt || cached.archivedAt || 0;

  // 1. 고정 감시 대상 (WATCH_LIST)
  const isPriority = (WATCH_LISTS[gallId] || []).includes(String(item.no));
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
async function processItem(dbMgr, gallId, item, referer = SOURCE + '/') {
  const no = item.no;
  try {
    const html = await fetchText(item.href, referer);
    if (html.includes("삭제된 게시글입니다") || html.includes("존재하지 않는 게시물입니다") || html.includes("잘못된 접근입니다")) {
      const prev = await dbMgr.getPost(no);
      await dbMgr.savePost(Object.assign({}, prev || {}, item, {
        category: '삭제글', deleted: 1, updatedAt: Date.now(), archivedAt: (prev && prev.archivedAt) || Date.now()
      }));
      console.log(`[Cleaner] ${no}번 글 삭제 확인 (키워드)`);
      return;
    }

    const post = parsePost(html, item.href);
    if (!post._isValid) {
      console.log(`[Validation Failed] Post no: ${no}, Title: ${post.title}`);
      return;
    }

    let contentHtml = post.bodyHtml || "";

    // 영상 태그 치환
    const videoPlaceholder = `<a href="${item.href}" target="_blank" class="video-placeholder" title="원본 글에서 영상 보기" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px; padding:6px 12px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; color:#475467; font-size:12px; margin:8px 0;">
      <span>📹</span><strong>원본 사이트 영상 (클릭)</strong></a>`;
    contentHtml = contentHtml.replace(/<(?:iframe|embed)[\s\S]*?<\/(?:iframe|embed)>|<(?:iframe|embed)[\s\S]*?>/gi, videoPlaceholder);

    // 불필요 태그 제거
    contentHtml = contentHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/on\w+="[^"]*"/gi, "");

    const prev = await dbMgr.getPost(no);
    post.comments = await fetchComments(dbMgr, gallId, no, item.page || 1, post, (prev && prev.comments) || []);

    const merged = Object.assign({}, prev || {}, post, {
      no: no,
      uid: post.uid || (prev && prev.uid) || (item && item.uid) || "",
      archivedAt: (prev && prev.archivedAt) || Date.now(),
      updatedAt: Date.now(),
      type: (post.type || item.type || (prev && prev.type) || 'normal'),
      commentCount: Math.max(Number(post.commentCount || 0), (prev && prev.comments ? prev.comments.length : 0))
    });

    // 이미지 로컬 캐싱
    if (post.images && post.images.length > 0) {
      const cached = [];
      const hashes = [];
      for (const img of post.images) {
        try {
          const result = await cacheImage(dbMgr, img, item.href, item.force);
          if (result && result.path) {
            cached.push(result.path);
            hashes.push(result.originalHash);
          } else if (result && result.isBlocked) {
            cached.push("blocked");
            hashes.push(result.originalHash);
          } else {
            cached.push(""); hashes.push("");
          }
        } catch (e) { cached.push(""); hashes.push(""); }
      }
      merged.localImages = cached.map((path, idx) => ({ path, originalHash: hashes[idx] }));

      // 🚨 [지능형 통합 매핑] 본문의 모든 미디어(img, video, source)를 로컬 이미지로 강제 치환
      if (post.images && post.images.length > 0) {
        let tagIdx = 0;
        // 본문의 모든 이미지/비디오 관련 태그를 훑으며 우리 서버의 이미지로 바꿉니다.
        contentHtml = contentHtml.replace(/<(?:img|video|source)[^>]+(?:src|data-original|data-src)=["'](https?:\/\/[^"']+)["'][^>]*>/gi, (match, src) => {
          if (src.includes('duckdns.org') || src.includes('/media/')) return match;

          let foundIdx = post.images.findIndex(img => img === src || decodeEntities(img) === src);
          if (foundIdx === -1) foundIdx = tagIdx;

          const localInfo = merged.localImages[foundIdx];
          tagIdx++;

          if (localInfo && localInfo.path) {
            if (localInfo.path === "blocked") {
              return `<div style="padding:15px; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b; font-size:11px; text-align:center; margin:10px 0;">차단된 이미지</div>`;
            }
            // 원본이 어떤 태그였든, 우리 서버의 로컬 이미지(<img>)로 강제 변환하여 박제합니다.
            return `<img src="${localInfo.path}" style="max-width:100%; display:block; margin:10px 0; border-radius:8px;">`;
          }
          return match;
        });

        // 2. [청소] 혹시나 남겨졌을지 모르는 비디오 닫기 태그(</video>) 등을 정리합니다.
        contentHtml = contentHtml.replace(/<\/video>/gi, "");
      }
    }

    contentHtml = contentHtml.replace(/<img[^>]+src=["'][^"']*gallview_loading_ori\.gif["'][^>]*>/gi, '');
    merged.contentHtml = contentHtml;
    await dbMgr.savePost(merged);
    console.log(`[Archive] 글 ${no} (${post.title}) 수집 완료`);

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


let crawlingStates = {};

async function backgroundCrawl(dbMgr, gallId, targetPages, isManual = false) {
  const gall = GALLERIES[gallId];
  const pCount = targetPages || CRAWL_PAGES;

  if (!isManual && crawlingStates[gallId]) return;
  if (!isManual && (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled)) return;

  crawlingStates[gallId] = true;
  try {
    for (let bp = 1; bp <= 1; bp++) { // 퀵싱크는 1페이지만 빠르게
      if (!isManual && (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled)) break;
      const html = await fetchText(`${SOURCE}/${gall.type}/board/lists/?id=${gall.id}&page=${bp}&exception_mode=recommend`, SOURCE + '/');
      const list = parseList(html, gallId);
      for (const item of list.items) {
        const prev = await dbMgr.getPost(item.no);
        if (prev && prev.type !== "best") {
          await dbMgr.run(`UPDATE posts SET type = 'best' WHERE no = ?`, [item.no]);
        }
        item.type = "best";
      }
      const targets = [];
      for (const i of list.items) { if (await shouldProcess(dbMgr, gallId, i)) targets.push(i); }
      for (const t of targets) { 
        if (!isManual && (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled)) break;
        await processItem(dbMgr, gallId, t); 
        await jitterWait(isManual ? 300 : 1000, isManual ? 600 : 2000); 
      }
    }
    for (let p = 1; p <= pCount; p++) {
      if (!isManual && (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled)) break;
      const listUrl = `${SOURCE}/${gall.type}/board/lists/?id=${gall.id}&page=${p}`;
      const html = await fetchText(listUrl, SOURCE + '/');
      const list = parseList(html, gallId); mergeCacheFromList(dbMgr, gallId, p, list);

      const targets = [];
      for (const i of list.items) { if ((p <= 3 || isManual) ? true : await shouldProcess(dbMgr, gallId, i)) targets.push(i); }
      for (const t of targets) {
        if (!isManual && (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled)) break;
        await processItem(dbMgr, gallId, t, listUrl);
        await jitterWait(isManual ? 500 : 2000, isManual ? 1000 : 5000);
      }
      if (!isManual) await jitterWait(5000, 10000);
    }
  } finally { crawlingStates[gallId] = false; }
}

let refreshingBestStates = {};
async function refreshBestPosts(dbMgr, gallId) {
  if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) return;
  if (refreshingBestStates[gallId] || crawlingStates[gallId]) return; refreshingBestStates[gallId] = true;
  try {
    const watchList = WATCH_LISTS[gallId] || [];
    const watchIds = watchList.length > 0 ? watchList.join(',') : '0';

    const targets = await dbMgr.query(`
      SELECT * FROM posts 
      WHERE (type = 'best' OR no IN (${watchIds}) OR no > (SELECT MAX(no) - 150 FROM posts))
      AND deleted = 0 
      ORDER BY no DESC 
      LIMIT ?
    `, [BEST_REFRESH_LIMIT]);

    for (const t of targets) { 
      if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) break;
      await processItem(dbMgr, gallId, t); 
      await jitterWait(2000, 5000); 
    }
  } finally { refreshingBestStates[gallId] = false; }
}

async function startupCatchup(dbMgr, gallId) {
  if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) return;
  const gall = GALLERIES[gallId];
  const lastRow = await dbMgr.get(`SELECT MAX(no) as maxNo FROM posts WHERE archivedAt > 0`);
  const last = lastRow ? lastRow.maxNo : 0;
  if (last === 0) return backgroundCrawl(dbMgr, gallId);

  crawlingStates[gallId] = true; try {
    for (let p = 1; p <= STARTUP_MAX_PAGES; p++) {
      if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) break;
      const html = await fetchText(`${SOURCE}/${gall.type}/board/lists/?id=${gall.id}&page=${p}`);
      const list = parseList(html, gallId); await mergeCacheFromList(dbMgr, gallId, p, list);

      const targets = [];
      for (const i of list.items) { if (p <= 3 ? true : await shouldProcess(dbMgr, gallId, i)) targets.push(i); }
      for (const t of targets) { 
        if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) break;
        await processItem(dbMgr, gallId, t); 
        await jitterWait(2000, 5000); 
      }

      const pMin = Math.min(...list.items.filter(i => i.type !== "notice").map(i => Number(i.no)));
      if (targets.length === 0 && pMin > 0 && pMin < last) break;
    }

    const recentPosts = await dbMgr.query(`SELECT * FROM posts WHERE deleted = 0 ORDER BY no DESC LIMIT 50`);
    console.log(`[System:${gallId}] 최근 글 ${recentPosts.length}개 상태 집중 점검 중...`);
    for (const t of recentPosts) {
      if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) break;
      await processItem(dbMgr, gallId, t);
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { crawlingStates[gallId] = false; }
}

// ── 최근 활성 글 정밀 삭제 감시 (Active Range Cleaner) ────────
const CLEANER_RANGE = 3000; // 최신 글 번호 기준 3000개 범위 집중 감시
let cleanerOffset = 0;

async function activeRangeCleaner(dbMgr, gallId) {
  if (GALLERY_SETTINGS[gallId]?.enabled === false) return;
  if (crawlingStates[gallId] || isIpThrottled) return;
  try {
    const maxRow = await dbMgr.get(`SELECT MAX(no) as maxNo FROM posts`);
    const maxNo = maxRow ? maxRow.maxNo : 0;
    if (maxNo === 0) return;

    const minNo = maxNo - CLEANER_RANGE;
    const targets = await dbMgr.query(
      `SELECT * FROM posts WHERE no > ? AND deleted = 0 ORDER BY updatedAt ASC LIMIT 5`,
      [minNo]
    );

    for (const t of targets) {
      await processItem(dbMgr, gallId, t);
      await jitterWait(3000, 7000);
    }
  } catch (e) {
    console.error(`[Cleaner:${gallId}] Active range scan failed:`, e.message);
  }
}

// ── 번호 예측 스나이퍼 (Predictive Sniper) ──────────────
let snifferStates = {};

async function sniffer(gallId) {
  if (GALLERY_SETTINGS[gallId]?.enabled === false) {
    setTimeout(() => sniffer(gallId), 30000);
    return;
  }
  const dbMgr = dbManagers[gallId];
  const gall = GALLERIES[gallId];
  if (!snifferStates[gallId]) snifferStates[gallId] = { lastKnownMaxId: 0, sniperDelay: 3000 };
  const state = snifferStates[gallId];

  if (crawlingStates[gallId] || isIpThrottled) {
    setTimeout(() => sniffer(gallId), 10000);
    return;
  }

  try {
    const listUrl = `${SOURCE}/${gall.type}/board/lists/?id=${gall.id}&page=1`;
    const html = await fetchTextHead(listUrl, SOURCE + '/');
    const list = parseList(html, gallId);
    const currentMax = Math.max(...list.items.map(i => Number(i.no) || 0));

    if (state.lastKnownMaxId === 0) {
      state.lastKnownMaxId = currentMax;
    } else if (currentMax > state.lastKnownMaxId) {
      const newItems = list.items.filter(i => Number(i.no) > state.lastKnownMaxId);
      console.log(`[Sniper:${gallId}] 새 글 ${newItems.length}개 발견! (${state.lastKnownMaxId} -> ${currentMax})`);
      state.lastKnownMaxId = currentMax;
      state.sniperDelay = 2000;

      const tasks = newItems.map(async (item, index) => {
        await new Promise(r => setTimeout(r, index * 150));
        return processItem(dbMgr, gallId, item, listUrl);
      });
      await Promise.all(tasks);
    } else {
      const nextId = state.lastKnownMaxId + 1;
      const targetUrl = buildDcUrl(gallId, nextId, 1);
      const futureHtml = await fetchText(targetUrl, SOURCE + '/').catch(() => null);

      if (futureHtml && !futureHtml.includes('삭제된 게시물') && !futureHtml.includes('잘못된 접근') && futureHtml.includes('class="title_subject"')) {
        console.log(`[Sniper:${gallId}] 🎯 예측 적중! 목록 노출 전 글 낚음: ${nextId}`);
        state.lastKnownMaxId = nextId;
        const parsed = parsePost(futureHtml, targetUrl);
        if (parsed._isValid) {
          await processItem(dbMgr, gallId, { no: nextId, href: targetUrl, type: 'normal', title: parsed.title }, SOURCE + '/');
        }
        state.sniperDelay = 1000;
      } else {
        state.sniperDelay = Math.min(state.sniperDelay + 1000, 10000);
      }
    }
  } catch (e) {
    state.sniperDelay = 10000;
  }

  setTimeout(() => sniffer(gallId), state.sniperDelay);
}

let recoveringCommentStates = {};
async function commentRecoveryEngine(dbMgr, gallId) {
  if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) return;
  if (recoveringCommentStates[gallId] || isIpThrottled) return;
  recoveringCommentStates[gallId] = true;
  try {
    const targets = await dbMgr.query(`
      SELECT p.* FROM posts p
      LEFT JOIN (SELECT postNo, COUNT(*) as cmt_cnt FROM comments GROUP BY postNo) c ON p.no = c.postNo
      WHERE p.deleted = 0 AND p.archivedAt > 0 
      AND p.commentCount > 0 
      AND (c.cmt_cnt IS NULL OR c.cmt_cnt = 0)
    `);
    if (targets.length === 0) return;
    const batch = targets
      .sort((a, b) => parseInt(b.no, 10) - parseInt(a.no, 10))
      .slice(0, 20);
    console.log(`[Recovery:${gallId}] 누락 ${targets.length}개 / 최신 ${batch.length}개 처리`);

    for (const post of batch) {
      if (GALLERY_SETTINGS[gallId]?.enabled === false || isIpThrottled) break;
      try {
        const targetUrl = post.href || buildDcUrl(gallId, post.no, 1);
        const html = await fetchText(targetUrl, SOURCE + '/');
        if (html.includes('삭제된 게시물') || html.includes('잘못된 접근')) {
          await dbMgr.run(`UPDATE posts SET deleted = 1 WHERE no = ?`, [post.no]);
        } else {
          const parsedPost = parsePost(html, post.href);
          const comments = await fetchComments(dbMgr, gallId, post.no, 1, parsedPost, post.comments || []);

          let localImages = post.localImages || [];
          if (parsedPost.images && parsedPost.images.length > 0 && localImages.length === 0) {
            const cached = [];
            for (const img of parsedPost.images) {
              try { const p = await cacheImage(dbMgr, img, post.href); if (p) cached.push(p); } catch (e) { }
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
      } catch (e) { }
    }
  } finally { recoveringCommentStates[gallId] = false; }
}

// 초기 기동 루프
(async () => {
  await initAllDatabases();
  for (const id in GALLERIES) {
    const dbMgr = dbManagers[id];
    startupCatchup(dbMgr, id).catch(() => { });
    setTimeout(() => sniffer(id), 5000);
    setInterval(() => backgroundCrawl(dbMgr, id, 1).catch(() => { }), 5 * 60 * 1000);
    setInterval(() => backgroundCrawl(dbMgr, id, CRAWL_PAGES).catch(() => { }), 30 * 60 * 1000);
    setTimeout(() => {
      refreshBestPosts(dbMgr, id);
      setInterval(() => refreshBestPosts(dbMgr, id), 10 * 60 * 1000);
    }, 3 * 60 * 1000);

    setTimeout(() => {
      commentRecoveryEngine(dbMgr, id).catch(() => { });
      setInterval(() => commentRecoveryEngine(dbMgr, id).catch(() => { }), 60 * 1000);
    }, 20 * 1000);

    // Active Range Cleaner 추가
    setInterval(() => activeRangeCleaner(dbMgr, id).catch(() => { }), 2 * 60 * 1000);
  }
})();


http.createServer(async (req, res) => {
  const parsed = urlLib.parse(req.url, true);
  try {
    if (await handleApi(parsed, res)) return;

    // 갤러리별 경로 처리 (/list/vr, /list/nevernesstoeverness 등)
    const isGalleryPath = Object.keys(GALLERIES).some(id =>
      parsed.pathname === `/list/${id}` || parsed.pathname.startsWith(`/view/${id}/`)
    );

    if (parsed.pathname === "/" || parsed.pathname === "/index.html" || isGalleryPath) {
      return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html; charset=utf-8");
    }

    if (parsed.pathname.startsWith("/media/")) {
      const f = path.join(MEDIA_DIR, path.basename(parsed.pathname));
      if (fs.existsSync(f)) {
        const ext = path.extname(f).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.png') mime = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.mp4') mime = 'video/mp4';
        else if (ext === '.webm') mime = 'video/webm';
        else if (ext === '.gif') mime = 'image/gif';
        return send(res, 200, fs.readFileSync(f), mime);
      }
    }
    send(res, 404, "Not found");
  } catch (e) { send(res, 500, e.message); }
}).listen(PORT, async () => {
  console.log(`
  ##################################################
  #                                                #
  #   🚀 MULTI-GALLERY ARCHIVE SYSTEM v3.0         #
  #   (SQLite Engine Activated)                     #
  #                                                #
  #   📡 Server : http://localhost:${PORT}          #`);

  for (const id in GALLERIES) {
    const dbMgr = dbManagers[id];
    const stats = await dbMgr.get("SELECT COUNT(*) as total FROM posts");
    console.log(`  #   📦 [${id}] Posts: ${(stats?.total || 0).toLocaleString().padEnd(10)} items`);
  }

  const mediaFiles = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).length : 0;
  console.log(`  #   🖼️  Media : ${mediaFiles.toLocaleString().padEnd(10)} files cached`);
  console.log(`  #                                                #
  ##################################################
  [System] ${new Date().toLocaleString()} 모든 엔진 가동 완료!
  `);
});
