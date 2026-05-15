const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class GalleryDB {
  constructor(dbName) {
    this.dbPath = path.join(__dirname, dbName);
    this.db = new Database(this.dbPath);
    this.insertPostStmt = null;
    this.insertCommentStmt = null;
    this.insertImageStmt = null;
  }

  async init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');

    this.db.exec(`CREATE TABLE IF NOT EXISTS posts (
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
      gallType TEXT,
      uid TEXT
    )`);

    // 기존 테이블에 누락된 컬럼들 추가
    try { this.db.exec(`ALTER TABLE posts ADD COLUMN contentHtml TEXT`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE posts ADD COLUMN uid TEXT`); } catch (e) {}

    this.db.exec(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      postNo INTEGER,
      name TEXT,
      meta TEXT,
      body TEXT,
      depth INTEGER DEFAULT 0,
      uid TEXT,
      icon TEXT,
      UNIQUE(postNo, meta, body),
      FOREIGN KEY(postNo) REFERENCES posts(no)
    )`);
    try { this.db.exec(`ALTER TABLE comments ADD COLUMN uid TEXT`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE comments ADD COLUMN icon TEXT`); } catch (e) {}

    this.db.exec(`CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      postNo INTEGER,
      path TEXT,
      originalHash TEXT,
      UNIQUE(postNo, path),
      FOREIGN KEY(postNo) REFERENCES posts(no)
    )`);
    try { this.db.exec(`ALTER TABLE images ADD COLUMN originalHash TEXT`); } catch (e) {}

    this.db.exec(`CREATE TABLE IF NOT EXISTS blacklisted_images (
      hash TEXT PRIMARY KEY,
      reason TEXT,
      createdAt INTEGER
    )`);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_type     ON posts(type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_deleted  ON posts(deleted)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_title    ON posts(title)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(author)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_updated  ON posts(updatedAt DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_type_no  ON posts(type, no DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_postNo ON comments(postNo)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_images_postNo  ON images(postNo)`);

    // [긴급 데이터 정화] 잘못 처리된 삭제 데이터 일괄 복구 및 말머리 정리
    const delCount = this.db.prepare('SELECT COUNT(*) as cnt FROM posts WHERE deleted = 1').get().cnt;
    if (delCount > 0) {
      console.log(`[DB:${this.dbPath}] ${delCount}개의 삭제된 글 말머리를 '삭제글'로 일괄 정리합니다...`);
      this.db.exec("UPDATE posts SET category = '삭제글' WHERE deleted = 1");
    }
    
    if (delCount > 4000) { // 4000개 이상이면 오작동으로 간주하고 초기화
      console.log(`[DB:${this.dbPath}] ${delCount}개의 잘못된 삭제 플래그를 발견하여 복구합니다...`);
      this.db.exec('UPDATE posts SET deleted = 0 WHERE deleted = 1');
    }

    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
      title, author, rawText,
      content='posts',
      content_rowid='no',
      tokenize='trigram'
    )`);

    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
      name, body,
      content='comments',
      content_rowid='id',
      tokenize='trigram'
    )`);

    // 🚨 1. 잘못된 문법으로 생성된 기존 트리거 강제 삭제
    this.db.exec(`DROP TRIGGER IF EXISTS posts_fts_ai`);
    this.db.exec(`DROP TRIGGER IF EXISTS posts_fts_au`);
    this.db.exec(`DROP TRIGGER IF EXISTS posts_fts_ad`);
    this.db.exec(`DROP TRIGGER IF EXISTS comments_fts_ai`);
    this.db.exec(`DROP TRIGGER IF EXISTS comments_fts_au`);
    this.db.exec(`DROP TRIGGER IF EXISTS comments_fts_ad`);

    // 🚨 2. FTS5 외부 테이블 전용 특수 트리거 생성
    this.db.exec(`CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(rowid, title, author, rawText)
      VALUES (new.no, new.title, new.author, new.rawText);
    END`);
    
    this.db.exec(`CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, title, author, rawText)
      VALUES ('delete', old.no, old.title, old.author, old.rawText);
      INSERT INTO posts_fts(rowid, title, author, rawText)
      VALUES (new.no, new.title, new.author, new.rawText);
    END`);
    
    this.db.exec(`CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, title, author, rawText)
      VALUES ('delete', old.no, old.title, old.author, old.rawText);
    END`);

    this.db.exec(`CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
      INSERT INTO comments_fts(rowid, name, body)
      VALUES (new.id, new.name, new.body);
    END`);
    
    this.db.exec(`CREATE TRIGGER comments_fts_au AFTER UPDATE ON comments BEGIN
      INSERT INTO comments_fts(comments_fts, rowid, name, body)
      VALUES ('delete', old.id, old.name, old.body);
      INSERT INTO comments_fts(rowid, name, body)
      VALUES (new.id, new.name, new.body);
    END`);
    
    this.db.exec(`CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
      INSERT INTO comments_fts(comments_fts, rowid, name, body)
      VALUES ('delete', old.id, old.name, old.body);
    END`);

    // 🚨 3. 누락된 기존 데이터 검색 색인 자동 빌드
    const postCount = this.db.prepare('SELECT COUNT(*) as cnt FROM posts').get().cnt;
    if (postCount > 0) {
      const ftsCount = this.db.prepare('SELECT COUNT(*) as cnt FROM posts_fts').get().cnt;
      if (ftsCount === 0) {
        console.log(`[DB:${this.dbPath}] FTS5 색인을 재구축합니다...`);
        this.db.exec(`INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')`);
        this.db.exec(`INSERT INTO comments_fts(comments_fts) VALUES ('rebuild')`);
      }
    }

    this.prepareStatements();
    console.log(`[DB:${this.dbPath}] Database initialized`);
  }

  prepareStatements() {
    if (this.insertPostStmt) return;
    this.insertPostStmt = this.db.prepare(`
      INSERT INTO posts (
        no, type, deleted, category, title, author, authorIcon, 
        commentCount, date, views, likes, href, archivedAt, updatedAt, 
        rawText, contentHtml, eSnO, boardType, gallType, uid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(no) DO UPDATE SET
        type        = CASE WHEN excluded.type IS NULL THEN posts.type WHEN excluded.type = 'best' THEN 'best' ELSE excluded.type END,
        deleted     = excluded.deleted,
        title       = excluded.title,
        author      = excluded.author,
        authorIcon  = excluded.authorIcon,
        commentCount= MAX(posts.commentCount, excluded.commentCount),
        date        = excluded.date,
        views       = excluded.views,
        likes       = excluded.likes,
        updatedAt   = excluded.updatedAt,
        rawText     = CASE WHEN excluded.rawText != '' THEN excluded.rawText ELSE posts.rawText END,
        contentHtml = CASE WHEN excluded.contentHtml != '' THEN excluded.contentHtml ELSE posts.contentHtml END,
        eSnO        = excluded.eSnO,
        boardType   = excluded.boardType,
        gallType    = excluded.gallType,
        uid         = CASE WHEN excluded.uid != '' THEN excluded.uid ELSE posts.uid END
    `);
    this.insertCommentStmt = this.db.prepare(`INSERT OR IGNORE INTO comments (postNo, name, meta, body, depth, uid, icon) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.insertImageStmt = this.db.prepare(`INSERT OR IGNORE INTO images (postNo, path, originalHash) VALUES (?, ?, ?)`);
  }

  async savePost(post) {
    const transaction = this.db.transaction((p) => {
      this.insertPostStmt.run(
        p.no, p.type || 'normal', p.deleted ? 1 : 0, p.category || '일반',
        p.title, p.author, p.authorIcon || '',
        p.commentCount || 0, p.date, p.views || 0, p.likes || 0,
        p.href, p.archivedAt || Date.now(), p.updatedAt || Date.now(),
        p.rawText || '', p.contentHtml || '', p.eSnO || '', p.boardType || '', p.gallType || '', p.uid || ''
      );

      if (p.comments && Array.isArray(p.comments)) {
        for (const c of p.comments) {
          this.insertCommentStmt.run(p.no, c.name || '', c.meta || '', c.body || '', c.depth || 0, c.uid || '', c.icon || '');
        }
      }

      if (p.localImages && Array.isArray(p.localImages)) {
        for (const img of p.localImages) {
          const path = typeof img === 'string' ? img : img.path;
          const hash = typeof img === 'string' ? '' : img.originalHash;
          this.insertImageStmt.run(p.no, path, hash || '');
        }
      }
    });

    transaction(post);
  }

  async getPost(no) {
    const [post, comments, imgs] = await Promise.all([
      this.db.prepare(`SELECT * FROM posts WHERE no = ?`).get(no),
      this.db.prepare(`SELECT name, meta, body, depth, uid, icon FROM comments WHERE postNo = ? ORDER BY id ASC`).all(no),
      this.db.prepare(`SELECT path FROM images WHERE postNo = ? ORDER BY id ASC`).all(no)
    ]);

    if (!post) return null;

    post.deleted = !!post.deleted;
    post.comments = comments;
    post.localImages = imgs.map(i => i.path);

    return post;
  }

  async getList({ mode, page, q, sm, perPage = 50 }) {
    let where = "WHERE 1=1";
    const params = [];
    let matchSql = "";
    const joinParams = [];

    if (mode === "recommand") {
      where += " AND p.type = 'best'";
    } else if (mode === "deleted") {
      where += " AND p.deleted = 1";
    } else if (mode === "normal") {
      where += " AND p.type = 'normal' AND p.deleted = 0";
    } else if (mode === "notice") {
      where += " AND p.type = 'notice'";
    } else if (mode === "all") {
      where += " AND p.deleted = 0";
    }

    if (q) {
      const isShort = q.trim().length < 3;
      const safeQ = q.replace(/"/g, '""');
      const whereParams = [];
      const matchParams = [];

      if (isShort) {
        const likeQ = `%${q}%`;
        if (sm === "hash") {
          where += " AND p.no IN (SELECT postNo FROM images WHERE originalHash = ?)";
          whereParams.push(q);
        } else if (sm === "author") {
          where += " AND p.author LIKE ?";
          whereParams.push(likeQ);
        } else if (sm === "comment") {
          where += " AND p.no IN (SELECT postNo FROM comments WHERE name LIKE ? OR body LIKE ?)";
          whereParams.push(likeQ, likeQ);
        } else if (sm === "total") {
          where += " AND (p.title LIKE ? OR p.author LIKE ? OR p.rawText LIKE ? OR p.no IN (SELECT postNo FROM comments WHERE name LIKE ? OR body LIKE ?))";
          whereParams.push(likeQ, likeQ, likeQ, likeQ, likeQ);
        } else if (sm === "uid") {
          where += " AND p.uid LIKE ?";
          whereParams.push(likeQ);
        } else if (sm === "title") {
          where += " AND p.title LIKE ?";
          whereParams.push(likeQ);
        } else if (sm === "body") {
          where += " AND p.rawText LIKE ?";
          whereParams.push(likeQ);
        } else {
          where += " AND (p.title LIKE ? OR p.rawText LIKE ?)";
          whereParams.push(likeQ, likeQ);
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
        const ftsQ = `"${safeQ}"`;
        if (sm === "hash") {
          where += " AND p.no IN (SELECT postNo FROM images WHERE originalHash = ?)";
          whereParams.push(q);
        } else if (sm === "author") {
          where += " AND p.author LIKE ?";
          whereParams.push(`%${q}%`);
        } else if (sm === "comment") {
          where += " AND p.no IN (SELECT postNo FROM comments WHERE id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ?))";
          whereParams.push(ftsQ);
        } else if (sm === "uid") {
          where += " AND p.uid LIKE ?";
          whereParams.push(`%${q}%`);
        } else if (sm === "total") {
          where += ` AND (
            p.no IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?) 
            OR p.no IN (SELECT postNo FROM comments WHERE id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ?))
            OR p.author LIKE ?
          )`;
          whereParams.push(ftsQ, ftsQ, `%${q}%`);
        } else if (sm === "title") {
          where += " AND p.no IN (SELECT rowid FROM posts_fts WHERE title MATCH ?)";
          whereParams.push(ftsQ);
        } else if (sm === "body") {
          where += " AND p.no IN (SELECT rowid FROM posts_fts WHERE rawText MATCH ?)";
          whereParams.push(ftsQ);
        } else {
          where += " AND p.no IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)";
          whereParams.push(ftsQ);
        }

        if (sm === "comment" || sm === "total") {
          matchSql += `
            LEFT JOIN (
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

    let total = 0;
    try {
      const countJoin = matchSql.split("LEFT JOIN")[0];
      const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM posts p ${countJoin} ${where}`).get(...params);
      total = countRow ? countRow.cnt : 0;
    } catch (e) {
      console.error("[DB Search Error] Count failed:", e.message);
    }

    const lastPage = Math.ceil(total / perPage) || 1;
    const currentPage = Math.max(1, Math.min(lastPage, Number(page || 1)));
    const offset = (currentPage - 1) * perPage;

    let items = [];
    try {
      const finalSql = `
        SELECT p.*, ${matchSql.includes("mc ON") ? "mc.matchedCount, mc.matchedSnippet" : "NULL as matchedCount, NULL as matchedSnippet"}
        FROM posts p ${matchSql} ${where}
        ORDER BY CASE WHEN p.type = 'notice' THEN 1 ELSE 0 END DESC, p.no DESC LIMIT ? OFFSET ?
      `;
      const rows = this.db.prepare(finalSql).all([...joinParams, ...params, perPage, offset]);

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

  async getAllNos() {
    const rows = this.db.prepare(`SELECT no FROM posts ORDER BY no DESC`).all();
    return rows.map(r => r.no);
  }

  async run(sql, params = []) { return this.db.prepare(sql).run(params); }
  async get(sql, params = []) { return this.db.prepare(sql).get(params); }
  async query(sql, params = []) { return this.db.prepare(sql).all(params); }

  async getPathByHash(hash) {
    if (!hash) return null;
    const row = this.db.prepare(`SELECT path FROM images WHERE originalHash = ? LIMIT 1`).get(hash);
    return row ? row.path : null;
  }

  async isBlacklisted(hash) {
    if (!hash) return false;
    const row = this.db.prepare(`SELECT 1 FROM blacklisted_images WHERE hash = ?`).get(hash);
    return !!row;
  }

  async blacklistImage(hash, reason = "혐짤") {
    this.db.prepare(`INSERT OR IGNORE INTO blacklisted_images (hash, reason, createdAt) VALUES (?, ?, ?)`).run(hash, reason, Date.now());
  }
}

module.exports = GalleryDB;
