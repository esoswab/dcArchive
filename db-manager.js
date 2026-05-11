const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'archive.db');
const db = new Database(DB_PATH);

// ── DB 초기화 ────────────────────────────────────────────────
async function init() {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');

  db.exec(`CREATE TABLE IF NOT EXISTS posts (
    no INTEGER PRIMARY KEY,
    type TEXT,
    deleted INTEGER DEFAULT 0,
    category TEXT,
    title TEXT,
    author TEXT,
    authorIcon TEXT,
    commentCount INTEGER DEFAULT 0,
    date TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    href TEXT,
    archivedAt INTEGER,
    updatedAt INTEGER,
    rawText TEXT,
    contentHtml TEXT,
    eSnO TEXT,
    boardType TEXT,
    gallType TEXT
  )`);

  // 기존 테이블에 contentHtml 컬럼이 없는 경우 추가
  try { db.exec(`ALTER TABLE posts ADD COLUMN contentHtml TEXT`); } catch (e) {}

  db.exec(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    postNo INTEGER,
    name TEXT,
    meta TEXT,
    body TEXT,
    depth INTEGER DEFAULT 0,
    UNIQUE(postNo, meta, body),
    FOREIGN KEY(postNo) REFERENCES posts(no)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    postNo INTEGER,
    path TEXT,
    UNIQUE(postNo, path),
    FOREIGN KEY(postNo) REFERENCES posts(no)
  )`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_type     ON posts(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_deleted  ON posts(deleted)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_title    ON posts(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(author)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_updated  ON posts(updatedAt DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_type_no  ON posts(type, no DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_postNo ON comments(postNo)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_images_postNo  ON images(postNo)`);

  // [긴급 데이터 정화] 잘못 처리된 삭제 데이터 일괄 복구 및 말머리 정리
  const delCount = db.prepare('SELECT COUNT(*) as cnt FROM posts WHERE deleted = 1').get().cnt;
  if (delCount > 0) {
    console.log(`[DB] ${delCount}개의 삭제된 글 말머리를 '삭제글'로 일괄 정리합니다...`);
    db.exec("UPDATE posts SET category = '삭제글' WHERE deleted = 1");
  }
  
  if (delCount > 4000) { // 4000개 이상이면 오작동으로 간주하고 초기화
    console.log(`[DB] ${delCount}개의 잘못된 삭제 플래그를 발견하여 복구합니다...`);
    db.exec('UPDATE posts SET deleted = 0 WHERE deleted = 1');
  }

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    title, author, rawText,
    content='posts',
    content_rowid='no',
    tokenize='trigram'
  )`);

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
    name, body,
    content='comments',
    content_rowid='id',
    tokenize='trigram'
  )`);

  // 🚨 1. 잘못된 문법으로 생성된 기존 트리거 강제 삭제
  db.exec(`DROP TRIGGER IF EXISTS posts_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS posts_fts_au`);
  db.exec(`DROP TRIGGER IF EXISTS posts_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS comments_fts_ai`);
  db.exec(`DROP TRIGGER IF EXISTS comments_fts_au`);
  db.exec(`DROP TRIGGER IF EXISTS comments_fts_ad`);

  // 🚨 2. FTS5 외부 테이블 전용 특수 트리거 생성 (반드시 'delete' 커맨드 사용)
  db.exec(`CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, author, rawText)
    VALUES (new.no, new.title, new.author, new.rawText);
  END`);
  
  db.exec(`CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, author, rawText)
    VALUES ('delete', old.no, old.title, old.author, old.rawText);
    INSERT INTO posts_fts(rowid, title, author, rawText)
    VALUES (new.no, new.title, new.author, new.rawText);
  END`);
  
  db.exec(`CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, author, rawText)
    VALUES ('delete', old.no, old.title, old.author, old.rawText);
  END`);

  db.exec(`CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
    INSERT INTO comments_fts(rowid, name, body)
    VALUES (new.id, new.name, new.body);
  END`);
  
  db.exec(`CREATE TRIGGER comments_fts_au AFTER UPDATE ON comments BEGIN
    INSERT INTO comments_fts(comments_fts, rowid, name, body)
    VALUES ('delete', old.id, old.name, old.body);
    INSERT INTO comments_fts(rowid, name, body)
    VALUES (new.id, new.name, new.body);
  END`);
  
  db.exec(`CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
    INSERT INTO comments_fts(comments_fts, rowid, name, body)
    VALUES ('delete', old.id, old.name, old.body);
  END`);

  // 🚨 3. 누락된 기존 데이터 검색 색인 자동 빌드 (강제 재구축 모드)
  const postCount = db.prepare('SELECT COUNT(*) as cnt FROM posts').get().cnt;
  
  if (postCount > 0) {
    console.log('[DB] FTS5 색인을 초기화하고 강제로 재구축합니다... (수십 초 소요될 수 있습니다)');
    // 1. 기존 색인 찌꺼기 완벽 삭제
    db.exec(`INSERT INTO posts_fts(posts_fts) VALUES ('delete-all')`);
    db.exec(`INSERT INTO comments_fts(comments_fts) VALUES ('delete-all')`);
    // 2. 새로운 룰로 완벽하게 재구축
    db.exec(`INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')`);
    db.exec(`INSERT INTO comments_fts(comments_fts) VALUES ('rebuild')`);
    console.log('[DB] FTS5 검색 엔진 강제 재구축 완료!');
  }

  console.log('[DB] Database initialized (FTS5 Trigram Engine Ready)');
}

let insertPostStmt, insertCommentStmt, insertImageStmt;

function prepareStatements() {
  if (insertPostStmt) return;
  insertPostStmt = db.prepare(`
    INSERT INTO posts (
      no, type, deleted, category, title, author, authorIcon, 
      commentCount, date, views, likes, href, archivedAt, updatedAt, 
      rawText, contentHtml, eSnO, boardType, gallType
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(no) DO UPDATE SET
      type        = CASE WHEN excluded.type = 'best' THEN 'best' ELSE excluded.type END,
      deleted     = excluded.deleted,
      title       = excluded.title,
      author      = excluded.author,
      authorIcon  = excluded.authorIcon,
      commentCount= excluded.commentCount,
      date        = excluded.date,
      views       = excluded.views,
      likes       = excluded.likes,
      updatedAt   = excluded.updatedAt,
      rawText     = CASE WHEN excluded.rawText != '' THEN excluded.rawText ELSE posts.rawText END,
      contentHtml = CASE WHEN excluded.contentHtml != '' THEN excluded.contentHtml ELSE posts.contentHtml END,
      eSnO        = excluded.eSnO,
      boardType   = excluded.boardType,
      gallType    = excluded.gallType
  `);
  insertCommentStmt = db.prepare(`INSERT OR IGNORE INTO comments (postNo, name, meta, body, depth) VALUES (?, ?, ?, ?, ?)`);
  insertImageStmt = db.prepare(`INSERT OR IGNORE INTO images (postNo, path) VALUES (?, ?)`);
}

async function savePost(post) {
  prepareStatements();
  const transaction = db.transaction((p) => {
    insertPostStmt.run(
      p.no, p.type, p.deleted ? 1 : 0, p.category || '일반',
      p.title, p.author, p.authorIcon || '',
      p.commentCount || 0, p.date, p.views || 0, p.likes || 0,
      p.href, p.archivedAt || Date.now(), p.updatedAt || Date.now(),
      p.rawText || '', p.contentHtml || '', p.eSnO || '', p.boardType || '', p.gallType || ''
    );

    if (p.comments && Array.isArray(p.comments)) {
      for (const c of p.comments) {
        insertCommentStmt.run(p.no, c.name || '', c.meta || '', c.body || '', c.depth || 0);
      }
    }

    if (p.localImages && Array.isArray(p.localImages)) {
      for (const img of p.localImages) {
        insertImageStmt.run(p.no, img);
      }
    }
  });

  transaction(post);
}

async function getPost(no) {
  const post = db.prepare(`SELECT * FROM posts WHERE no = ?`).get(no);
  if (!post) return null;

  post.deleted = !!post.deleted;
  post.comments = db.prepare(`SELECT name, meta, body, depth FROM comments WHERE postNo = ? ORDER BY id ASC`).all(no);
  const imgs = db.prepare(`SELECT path FROM images WHERE postNo = ? ORDER BY id ASC`).all(no);
  post.localImages = imgs.map(i => i.path);

  return post;
}

async function getList({ mode, page, q, sm, perPage = 50 }) {
  let where = "WHERE 1=1";
  const params = [];
  let matchSql = "";
  const joinParams = [];

  // 1. 기본 모드 필터링
  if (mode === "recommand") {
    where += " AND p.type = 'best'";
  } else if (mode === "deleted") {
    where += " AND p.deleted = 1";
  } else if (mode === "normal") {
    where += " AND p.type = 'normal' AND p.deleted = 0"; // 진짜 일반글만: best/notice 제외
  } else if (mode === "notice") {
    where += " AND p.type = 'notice'";
  } else if (mode === "all") {
    where += " AND p.deleted = 0"; // 전체보기에서만 모든 유형 포함
  }

  // 2. 하이브리드 검색 로직
  if (q) {
    const isShort = q.trim().length < 3;
    const safeQ = q.replace(/"/g, '""');
    const whereParams = [];
    const matchParams = [];

    if (isShort) {
      console.log(`[DB Debug] Short Query: "${q}", Mode: "${sm}"`);
      // 🚀 [1~2글자] LIKE 방식
      const likeQ = `%${q}%`;
      if (sm === "author") {
        where += " AND p.author LIKE ?";
        whereParams.push(likeQ);
      } else if (sm === "comment") {
        where += " AND p.no IN (SELECT postNo FROM comments WHERE name LIKE ? OR body LIKE ?)";
        whereParams.push(likeQ, likeQ);
      } else if (sm === "total") {
        // 전체 검색 (글 + 댓글)
        where += " AND (p.title LIKE ? OR p.author LIKE ? OR p.rawText LIKE ? OR p.no IN (SELECT postNo FROM comments WHERE name LIKE ? OR body LIKE ?))";
        whereParams.push(likeQ, likeQ, likeQ, likeQ, likeQ);
      } else {
        // 기본값: 제목+본문 (title_body)
        where += " AND (p.title LIKE ? OR p.author LIKE ? OR p.rawText LIKE ?)";
        whereParams.push(likeQ, likeQ, likeQ);
      }

      if (sm === "comment" || sm === "total") {
        matchSql = `
          LEFT JOIN (
            SELECT postNo, COUNT(*) as matchedCount, GROUP_CONCAT(name || '|||' || body, '~~~') as matchedSnippet
            FROM (
              SELECT postNo, name, body FROM comments
              WHERE name LIKE ? OR body LIKE ?
              ORDER BY id ASC
            )
            GROUP BY postNo
          ) mc ON p.no = mc.postNo`;
        matchParams.push(likeQ, likeQ);
      }
    } else {
      console.log(`[DB Debug] Long Query: "${q}", Mode: "${sm}"`);
      // 🚀 [3글자 이상] FTS5 Trigram 방식
      const ftsQ = `"${safeQ}"`;
      if (sm === "author") {
        where += " AND p.author LIKE ?";
        whereParams.push(`%${q}%`);
      } else if (sm === "comment") {
        where += " AND p.no IN (SELECT postNo FROM comments WHERE id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ?))";
        whereParams.push(ftsQ);
      } else if (sm === "total") {
        where += ` AND (
          p.no IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?) 
          OR p.no IN (SELECT postNo FROM comments WHERE id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ?))
          OR p.author LIKE ?
        )`;
        whereParams.push(ftsQ, ftsQ, `%${q}%`);
      } else {
        // 기본값: 제목+본문 (title_body)
        where += ` AND (
          p.no IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?) 
          OR p.author LIKE ?
        )`;
        whereParams.push(ftsQ, `%${q}%`);
      }

      if (sm === "comment" || sm === "total") {
        const joinType = matchSql.includes("JOIN posts_fts") ? "LEFT JOIN" : "LEFT JOIN";
        matchSql += `
          ${joinType} (
            SELECT postNo, COUNT(*) as matchedCount, GROUP_CONCAT(name || '|||' || body, '~~~') as matchedSnippet
            FROM (
              SELECT postNo, name, body FROM comments
              WHERE id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ?)
              ORDER BY id ASC
            )
            GROUP BY postNo
          ) mc ON p.no = mc.postNo`;
        matchParams.push(ftsQ);
      }
    }
    params.push(...whereParams);
    joinParams.push(...matchParams);
  }

  // 3. 데이터 개수 및 페이징 계산
  let total = 0;
  try {
    const countJoin = matchSql.split("LEFT JOIN")[0];
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM posts p ${countJoin} ${where}`).get(...params);
    total = countRow ? countRow.cnt : 0;
  } catch (e) {
    console.error("[DB Search Error] Count failed:", e.message);
  }

  const lastPage = Math.ceil(total / perPage) || 1;
  const currentPage = Math.max(1, Math.min(lastPage, Number(page || 1)));
  const offset = (currentPage - 1) * perPage;

  // 4. 최종 데이터 쿼리
  let items = [];
  try {
    const finalSql = `
      SELECT p.*, ${matchSql.includes("mc ON") ? "mc.matchedCount, mc.matchedSnippet" : "NULL as matchedCount, NULL as matchedSnippet"}
      FROM posts p ${matchSql} ${where}
      ORDER BY CASE WHEN p.type = 'notice' THEN 1 ELSE 0 END DESC, p.no DESC LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(finalSql).all([...joinParams, ...params, perPage, offset]);

    items = rows.map(row => {
      row.deleted = !!row.deleted;
      if (row.matchedSnippet) {
        row.matchedComments = row.matchedSnippet.split("~~~").slice(0, 3).map(s => {
          const [name, body] = s.split("|||");
          return { name, body };
        });
        row.totalMatched = row.matchedCount || 0;
      }
      delete row.matchedSnippet;
      delete row.matchedCount;
      return row;
    });
  } catch (e) {
    console.error("[DB Search Error] Query failed:", e.message);
  }

  return { items, lastPage, total };
}

async function getAllNos() {
  const rows = db.prepare(`SELECT no FROM posts ORDER BY no DESC`).all();
  return rows.map(r => r.no);
}

const run = async (sql, params = []) => db.prepare(sql).run(params);
const get = async (sql, params = []) => db.prepare(sql).get(params);
const query = async (sql, params = []) => db.prepare(sql).all(params);

module.exports = {
  init,
  savePost,
  getPost,
  getList,
  getAllNos,
  query,
  run,
  get,
  db
};
